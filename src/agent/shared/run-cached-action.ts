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
  llm: any;
  mcpClient: any;
  variables: Array<{ key: string; value: string; description: string }>;
  preferScriptBoundingBox?: boolean;
  cdpActionsEnabled?: boolean;
  performFallback?: (instruction: string) => Promise<TaskOutput>;
}

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

  if (cachedAction.actionType === "goToUrl") {
    const url =
      (cachedAction.arguments && cachedAction.arguments[0]) ||
      (cachedAction.actionParams as any)?.url ||
      "";
    if (!url || typeof url !== "string") {
      return {
        taskId,
        status: TaskStatus.FAILED,
        steps: [],
        output: "Missing URL for goToUrl",
      };
    }
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await waitForSettledDOM(page);
    markDomSnapshotDirty(page);
    return {
      taskId,
      status: TaskStatus.COMPLETED,
      steps: [],
      output: `Navigated to ${url}`,
      replayStepMeta: {
        usedCachedAction: true,
        fallbackUsed: false,
        retries: 1,
        cachedXPath: null,
        fallbackXPath: null,
        fallbackElementId: null,
      },
    };
  }

  if (cachedAction.actionType === "complete") {
    return {
      taskId,
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "Task Complete",
      replayStepMeta: {
        usedCachedAction: true,
        fallbackUsed: false,
        retries: 1,
        cachedXPath: null,
        fallbackXPath: null,
        fallbackElementId: null,
      },
    };
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

  for (let attempt = 0; attempt < maxSteps; attempt++) {
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
      if (attempt < maxSteps - 1) {
        continue;
      }
      // will fall through to fallback/final failure below
    } else if (!attemptResult.success) {
      lastError = new Error(attemptResult.message);
      if (attempt < maxSteps - 1) {
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
    const fb = await params.performFallback(instruction);
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
    return {
      ...fb,
      replayStepMeta: {
        usedCachedAction: true,
        fallbackUsed: true,
        retries: maxSteps,
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
      (lastError as Error | null)?.message || "Failed to execute cached action",
    replayStepMeta: {
      usedCachedAction: true,
      fallbackUsed: false,
      retries: maxSteps,
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
  llm: any;
  mcpClient: any;
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

export async function performGoTo(
  page: import("playwright-core").Page,
  url: string,
  waitUntil: "domcontentloaded" | "load" | "networkidle" = "domcontentloaded"
): Promise<void> {
  await page.goto(url, { waitUntil });
  await waitForSettledDOM(page);
  markDomSnapshotDirty(page);
}
