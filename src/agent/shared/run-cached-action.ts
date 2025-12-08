import { v4 as uuidv4 } from "uuid";
import { ActionContext } from "@/types";
import { performAction } from "@/agent/actions/shared/perform-action";
import { captureDOMState } from "@/agent/shared/dom-capture";
import { waitForSettledDOM } from "@/utils/waitForSettledDOM";
import { markDomSnapshotDirty } from "@/context-providers/a11y-dom/dom-cache";
import { initializeRuntimeContext } from "@/agent/shared/runtime-context";
import { resolveXPathWithCDP } from "@/agent/shared/xpath-cdp-resolver";
import { TaskOutput, TaskStatus } from "@/types/agent/types";
import { resolveElement, dispatchCDPAction } from "@/cdp";

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

  for (let attempt = 0; attempt < maxSteps; attempt++) {
    try {
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
        xpath: cachedAction.xpath,
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
        [encodedId]: cachedAction.xpath,
      };

      const methodArgs = (cachedAction.arguments ?? []).map((v) =>
        v == null ? "" : String(v)
      );

      const actionOutput = await performAction(actionContext, {
        elementId: encodedId,
        method: cachedAction.method,
        arguments: methodArgs,
        instruction,
        confidence: 1,
      });

      if (!actionOutput.success) {
        throw new Error(actionOutput.message);
      }

      await waitForSettledDOM(page);
      markDomSnapshotDirty(page);

      return {
        taskId,
        status: TaskStatus.COMPLETED,
        steps: [],
        output: `Executed cached action: ${instruction}`,
        replayStepMeta: {
          usedCachedAction: true,
          fallbackUsed: false,
          retries: attempt + 1,
          cachedXPath: cachedAction.xpath ?? null,
          fallbackXPath: null,
          fallbackElementId: null,
        },
      };
    } catch (error) {
      if (attempt >= maxSteps - 1) {
        return {
          taskId,
          status: TaskStatus.FAILED,
          steps: [],
          output:
            (error as Error)?.message || "Failed to execute cached action",
          replayStepMeta: {
            usedCachedAction: true,
            fallbackUsed: false,
            retries: attempt + 1,
            cachedXPath: cachedAction.xpath ?? null,
            fallbackXPath: null,
            fallbackElementId: null,
          },
        };
      }
    }
  }

  return {
    taskId,
    status: TaskStatus.FAILED,
    steps: [],
    output: "Failed to execute cached action",
  };
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
