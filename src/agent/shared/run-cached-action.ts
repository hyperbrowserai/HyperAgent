import { v4 as uuidv4 } from "uuid";
import { ActionContext } from "@/types";
import { performAction } from "@/agent/actions/shared/perform-action";
import { captureDOMState } from "@/agent/shared/dom-capture";
import { waitForSettledDOM } from "@/utils/waitForSettledDOM";
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

const normalizeMaxSteps = (value: number): number =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;

const formatUnknownError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
};

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

  const specialActionResult = await executeReplaySpecialAction({
    taskId,
    actionType: cachedAction.actionType,
    instruction,
    arguments: cachedAction.arguments,
    actionParams: isRecord(cachedAction.actionParams)
      ? cachedAction.actionParams
      : undefined,
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
        cachedXPath: cachedAction.xpath ?? null,
        fallbackXPath: null,
        fallbackElementId: null,
      },
    } satisfies TaskOutput;
  });
  if (specialActionResult) {
    return specialActionResult;
  }

  if (
    cachedAction.actionType !== "actElement" ||
    !cachedAction.xpath ||
    !cachedAction.method
  ) {
    return {
      taskId,
      status: TaskStatus.FAILED,
      steps: [],
      output: "Unsupported cached action",
    };
  }

  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const attemptIndex = attempt + 1;
    const attemptResult = await runCachedAttempt({
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
          cachedXPath: cachedAction.xpath ?? null,
          fallbackXPath: null,
          fallbackElementId: null,
        },
      };
    }
  }

  // All cached attempts failed; optionally fall back to LLM perform
  if (params.performFallback) {
    const fb = await params.performFallback(instruction).catch((error) => {
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
          cachedXPath: cachedAction.xpath ?? null,
          fallbackXPath: null,
          fallbackElementId: null,
        },
      } satisfies TaskOutput;
    });
    if (debug) {
      const cachedXPath = cachedAction.xpath || "N/A";
      const resolvedXPath = fb.replayStepMeta?.fallbackXPath || "N/A";
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
    return {
      ...fb,
      replayStepMeta: {
        usedCachedAction: true,
        fallbackUsed: true,
        retries: attempts,
        cachedXPath: cachedAction.xpath ?? null,
        fallbackXPath: fb.replayStepMeta?.fallbackXPath ?? null,
        fallbackElementId: fb.replayStepMeta?.fallbackElementId ?? null,
      },
    };
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
      cachedXPath: cachedAction.xpath ?? null,
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

  const methodArgs = (cachedAction.arguments ?? []).map((v) =>
    v == null ? "" : String(v)
  );

  const actionOutput = await performAction(actionContext, {
    elementId: encodedId,
    method: cachedAction.method!,
    arguments: methodArgs,
    instruction,
    confidence: 1,
  });

  return { success: actionOutput.success, message: actionOutput.message };
}

