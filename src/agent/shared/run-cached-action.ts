import { v4 as uuidv4 } from "uuid";
import { ActionContext } from "@/types";
import { performAction } from "@/agent/actions/shared/perform-action";
import { captureDOMState } from "@/agent/shared/dom-capture";
import { waitForSettledDOM } from "@/utils/waitForSettledDOM";
import { formatUnknownError } from "@/utils";
import { markDomSnapshotDirty } from "@/context-providers/a11y-dom/dom-cache";
import { initializeRuntimeContext } from "@/agent/shared/runtime-context";
import { resolveXPathWithCDP } from "@/agent/shared/xpath-cdp-resolver";
import { resolveElement, dispatchCDPAction } from "@/cdp";
import { TaskOutput, TaskStatus } from "@/types/agent/types";
import { executeReplaySpecialAction } from "@/agent/shared/replay-special-actions";

export interface CachedActionInput {
  actionType: string;
  xpath?: string | null;
  frameIndex?: number | null;
  method?: string | null;
  arguments?: Array<string | number>;
  actionParams?: Record<string, unknown>;
}

export interface RunCachedStepParams {
  page: import("playwright-core").Page;
  instruction: string;
  cachedAction: CachedActionInput;
  maxSteps?: number;
  debug?: boolean;
  tokenLimit: number;
  llm: ActionContext["llm"];
  mcpClient: ActionContext["mcpClient"];
  variables: Array<{ key: string; value: string; description: string }>;
  preferScriptBoundingBox?: boolean;
  cdpActionsEnabled?: boolean;
  performFallback?: (instruction: string) => Promise<TaskOutput>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const MAX_CACHED_ACTION_ARGS = 20;
const MAX_CACHED_ACTION_ARG_CHARS = 2_000;

const safeReadCachedActionField = (
  cachedAction: CachedActionInput,
  key: keyof CachedActionInput
): unknown => {
  try {
    return (cachedAction as unknown as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
};

const normalizeOptionalTrimmedString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const normalizeCachedActionArguments = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  let entries: unknown[];
  try {
    entries = Array.from(value);
  } catch {
    return [];
  }
  return entries.slice(0, MAX_CACHED_ACTION_ARGS).map((entry) => {
    const normalized = entry == null ? "" : String(entry);
    if (normalized.length <= MAX_CACHED_ACTION_ARG_CHARS) {
      return normalized;
    }
    return normalized.slice(0, MAX_CACHED_ACTION_ARG_CHARS);
  });
};

const normalizeCachedFrameIndex = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
};

const safeReadTaskOutputField = (
  value: unknown,
  key: keyof TaskOutput
): unknown => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
};

const safeReadRecordField = (
  value: unknown,
  key: string
): unknown => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
};

const normalizeTaskStatus = (value: unknown): TaskStatus => {
  if (
    value === TaskStatus.COMPLETED ||
    value === TaskStatus.FAILED ||
    value === TaskStatus.CANCELLED ||
    value === TaskStatus.PAUSED ||
    value === TaskStatus.PENDING ||
    value === TaskStatus.RUNNING
  ) {
    return value;
  }
  return TaskStatus.FAILED;
};

function normalizeFallbackTaskOutput(
  fallbackResult: unknown,
  taskId: string,
  retries: number,
  cachedXPath: string | null
): TaskOutput {
  const status = normalizeTaskStatus(safeReadTaskOutputField(fallbackResult, "status"));
  const outputValue = safeReadTaskOutputField(fallbackResult, "output");
  const replayStepMetaValue = safeReadTaskOutputField(
    fallbackResult,
    "replayStepMeta"
  );
  const normalizedReplayStepMeta = isRecord(replayStepMetaValue)
    ? replayStepMetaValue
    : undefined;

  return {
    taskId:
      normalizeOptionalTrimmedString(
        safeReadTaskOutputField(fallbackResult, "taskId")
      ) ?? taskId,
    status,
    steps: [],
    output:
      typeof outputValue === "string"
        ? outputValue
        : status === TaskStatus.FAILED
          ? "Fallback perform returned an invalid response payload."
          : "Fallback perform completed.",
    replayStepMeta: {
      usedCachedAction: true,
      fallbackUsed: true,
      retries,
      cachedXPath,
      fallbackXPath:
        normalizeOptionalTrimmedString(
          safeReadRecordField(normalizedReplayStepMeta, "fallbackXPath")
        ) ?? null,
      fallbackElementId:
        normalizeOptionalTrimmedString(
          safeReadRecordField(normalizedReplayStepMeta, "fallbackElementId")
        ) ?? null,
    },
  };
}

const normalizeMaxSteps = (value: number): number =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;

export async function runCachedStep(
  params: RunCachedStepParams
): Promise<TaskOutput> {
  const {
    page,
    instruction,
    cachedAction,
    maxSteps = 3,
    debug,
    tokenLimit,
    llm,
    mcpClient,
    variables,
    preferScriptBoundingBox,
    cdpActionsEnabled,
  } = params;

  const taskId = uuidv4();
  const attempts = normalizeMaxSteps(maxSteps);
  const normalizedActionType =
    normalizeOptionalTrimmedString(
      safeReadCachedActionField(cachedAction, "actionType")
    ) ?? "unknown";
  const normalizedXPath = normalizeOptionalTrimmedString(
    safeReadCachedActionField(cachedAction, "xpath")
  );
  const normalizedMethod = normalizeOptionalTrimmedString(
    safeReadCachedActionField(cachedAction, "method")
  );
  const normalizedArguments = normalizeCachedActionArguments(
    safeReadCachedActionField(cachedAction, "arguments")
  );
  const normalizedFrameIndex = normalizeCachedFrameIndex(
    safeReadCachedActionField(cachedAction, "frameIndex")
  );
  const actionParamsValue = safeReadCachedActionField(cachedAction, "actionParams");
  const normalizedCachedAction: CachedActionInput = {
    actionType: normalizedActionType,
    actionParams: isRecord(actionParamsValue) ? actionParamsValue : undefined,
    arguments: normalizedArguments,
    frameIndex: normalizedFrameIndex,
    xpath: normalizedXPath,
    method: normalizedMethod,
  };

  const specialActionResult = await executeReplaySpecialAction({
    taskId,
    actionType: normalizedActionType,
    instruction,
    arguments: normalizedArguments,
    actionParams: normalizedCachedAction.actionParams,
    page,
    retries: 1,
  }).catch((error) => {
    const message = formatUnknownError(error);
    return {
      taskId,
      status: TaskStatus.FAILED,
      steps: [],
      output: `Failed to execute cached special action: ${message}`,
      replayStepMeta: {
        usedCachedAction: true,
        fallbackUsed: false,
        retries: 1,
        cachedXPath: normalizedXPath ?? null,
        fallbackXPath: null,
        fallbackElementId: null,
      },
    } satisfies TaskOutput;
  });
  if (specialActionResult) {
    return specialActionResult;
  }

  if (
    normalizedActionType !== "actElement" ||
    !normalizedXPath ||
    !normalizedMethod
  ) {
    return {
      taskId,
      status: TaskStatus.FAILED,
      steps: [],
      output: "Unsupported cached action",
      replayStepMeta: {
        usedCachedAction: true,
        fallbackUsed: false,
        retries: 1,
        cachedXPath: normalizedXPath ?? null,
        fallbackXPath: null,
        fallbackElementId: null,
      },
    };
  }

  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const attemptIndex = attempt + 1;
    const attemptResult = await runCachedAttempt({
      page,
      instruction,
      cachedAction: normalizedCachedAction,
      debug,
      tokenLimit,
      llm,
      mcpClient,
      variables,
      preferScriptBoundingBox,
      cdpActionsEnabled,
    }).catch((err) => {
      lastError = err;
      return null;
    });

    if (!attemptResult) {
      if (attempt < attempts - 1) {
        continue;
      }
      // will fall through to fallback/final failure below
    } else if (!attemptResult.success) {
      lastError = new Error(attemptResult.message);
      if (attempt < attempts - 1) {
        continue;
      }
      // will fall through to fallback/final failure below
    } else {
      await waitForSettledDOM(page);
      markDomSnapshotDirty(page);
      lastError = null;
      return {
        taskId,
        status: TaskStatus.COMPLETED,
        steps: [],
        output: `Executed cached action: ${instruction}`,
        replayStepMeta: {
          usedCachedAction: true,
          fallbackUsed: false,
          retries: attemptIndex,
          cachedXPath: normalizedXPath ?? null,
          fallbackXPath: null,
          fallbackElementId: null,
        },
      };
    }
  }

  // All cached attempts failed; optionally fall back to LLM perform
  if (params.performFallback) {
    const fallbackResult = await params.performFallback(instruction).catch((error) => {
      const message = formatUnknownError(error);
      return {
        taskId,
        status: TaskStatus.FAILED,
        steps: [],
        output: `Fallback perform failed: ${message}`,
        replayStepMeta: {
          usedCachedAction: true,
          fallbackUsed: true,
          retries: attempts,
          cachedXPath: normalizedXPath ?? null,
          fallbackXPath: null,
          fallbackElementId: null,
        },
      } satisfies TaskOutput;
    });
    const normalizedFallback = normalizeFallbackTaskOutput(
      fallbackResult,
      taskId,
      attempts,
      normalizedXPath ?? null
    );
    if (debug) {
      const cachedXPath = normalizedXPath || "N/A";
      const resolvedXPath =
        normalizedFallback.replayStepMeta?.fallbackXPath || "N/A";
      // eslint-disable-next-line no-console
      console.log(
        `
⚠️ [runCachedStep] Cached action failed. Falling back to LLM...
   Instruction: "${instruction}"
   ❌ Cached XPath Failed: "${cachedXPath}"
   ✅ LLM Resolved New XPath: "${resolvedXPath}"
`
      );
    }
    return normalizedFallback;
  }

  return {
    taskId,
    status: TaskStatus.FAILED,
    steps: [],
    output:
      (lastError !== null
        ? formatUnknownError(lastError)
        : "Failed to execute cached action"),
    replayStepMeta: {
      usedCachedAction: true,
      fallbackUsed: false,
      retries: attempts,
      cachedXPath: normalizedXPath ?? null,
      fallbackXPath: null,
      fallbackElementId: null,
    },
  };
}

async function runCachedAttempt(args: {
  page: import("playwright-core").Page;
  instruction: string;
  cachedAction: CachedActionInput;
  debug?: boolean;
  tokenLimit: number;
  llm: ActionContext["llm"];
  mcpClient: ActionContext["mcpClient"];
  variables: Array<{ key: string; value: string; description: string }>;
  preferScriptBoundingBox?: boolean;
  cdpActionsEnabled?: boolean;
}): Promise<{ success: boolean; message: string }> {
  const {
    page,
    instruction,
    cachedAction,
    debug,
    tokenLimit,
    llm,
    mcpClient,
    variables,
    preferScriptBoundingBox,
    cdpActionsEnabled,
  } = args;

  await waitForSettledDOM(page);
  const domState = await captureDOMState(page, {
    useCache: false,
    debug,
    enableVisualMode: false,
  });

  const { cdpClient, frameContextManager } = await initializeRuntimeContext(
    page,
    debug
  );
  const resolved = await resolveXPathWithCDP({
    xpath: cachedAction.xpath!,
    frameIndex: cachedAction.frameIndex ?? 0,
    cdpClient,
    frameContextManager,
    debug,
  });

  const actionContext: ActionContext = {
    domState,
    page,
    tokenLimit,
    llm,
    debug,
    cdpActions: cdpActionsEnabled !== false,
    cdp: {
      client: cdpClient,
      frameContextManager,
      resolveElement,
      dispatchCDPAction,
      preferScriptBoundingBox: preferScriptBoundingBox ?? debug,
      debug,
    },
    debugDir: undefined,
    mcpClient,
    variables,
    invalidateDomCache: () => markDomSnapshotDirty(page),
  };

  const encodedId = `${cachedAction.frameIndex ?? 0}-${resolved.backendNodeId}`;
  domState.backendNodeMap = {
    ...(domState.backendNodeMap || {}),
    [encodedId]: resolved.backendNodeId,
  };
  domState.xpathMap = {
    ...(domState.xpathMap || {}),
    [encodedId]: cachedAction.xpath!,
  };

  const methodArgs = normalizeCachedActionArguments(cachedAction.arguments);

  const actionOutput = await performAction(actionContext, {
    elementId: encodedId,
    method: cachedAction.method!,
    arguments: methodArgs,
    instruction,
    confidence: 1,
  });

  return { success: actionOutput.success, message: actionOutput.message };
}

