import { AgentStep } from "@/types/agent/types";
import type { FrameChunkEvent } from "@/context-providers/a11y-dom/types";
import fs from "fs";

import { performance } from "perf_hooks";
import {
  ActionContext,
  ActionOutput,
  ActionType,
  AgentActionDefinition,
} from "@/types";
import { getA11yDOM } from "@/context-providers/a11y-dom";
import { markDomSnapshotDirty } from "@/context-providers/a11y-dom/dom-cache";
import {
  getCDPClient,
  resolveElement,
  dispatchCDPAction,
  getOrCreateFrameContextManager,
} from "@/cdp";
import { retry } from "@/utils/retry";
import { sleep } from "@/utils/sleep";
import { waitForSettledDOM } from "@/utils/waitForSettledDOM";

import { AgentOutputFn, endTaskStatuses } from "@hyperbrowser/agent/types";
import {
  TaskParams,
  TaskOutput,
  TaskState,
  TaskStatus,
} from "@hyperbrowser/agent/types";

import { HyperagentError } from "../error";
import { buildAgentStepMessages } from "../messages/builder";
import { SYSTEM_PROMPT } from "../messages/system-prompt";
import { z } from "zod";
import { A11yDOMState } from "@/context-providers/a11y-dom/types";
import { Page } from "playwright-core";
import { ActionNotFoundError } from "../actions";
import { AgentCtx } from "./types";
import { HyperAgentMessage } from "@/llm/types";
import { Jimp } from "jimp";

class DomChunkAggregator {
  private parts: string[] = [];
  private pending = new Map<number, FrameChunkEvent>();
  private nextOrder = 0;

  push(chunk: FrameChunkEvent): void {
    this.pending.set(chunk.order, chunk);
    this.flush();
  }

  private flush(): void {
    while (true) {
      const chunk = this.pending.get(this.nextOrder);
      if (!chunk) break;
      this.pending.delete(this.nextOrder);
      this.parts.push(chunk.simplified.trim());
      this.nextOrder += 1;
    }
  }

  hasContent(): boolean {
    return this.parts.length > 0;
  }

  toString(): string {
    return this.parts.join("\n\n");
  }
}
const READ_ONLY_ACTIONS = new Set(["thinking", "wait", "extract", "complete"]);

const ensureFrameContextsReady = async (
  page: Page,
  debug: boolean | undefined,
  _featureFlags?: TaskParams["featureFlags"]
): Promise<void> => {
  try {
    const cdpClient = await getCDPClient(page);
    const frameManager = getOrCreateFrameContextManager(cdpClient);
    await frameManager.ensureInitialized();
  } catch (error) {
    if (debug) {
      console.warn(
        "[FrameContext] Failed to initialize frame context manager:",
        error
      );
    }
  }
};

const writeFrameGraphSnapshot = async (
  page: Page,
  dir: string,
  debug?: boolean
): Promise<void> => {
  try {
    const cdpClient = await getCDPClient(page);
    const frameManager = getOrCreateFrameContextManager(cdpClient);
    const data = frameManager.toJSON();
    fs.writeFileSync(
      `${dir}/frames.json`,
      JSON.stringify(data, null, 2)
    );
  } catch (error) {
    if (debug) {
      console.warn("[FrameContext] Failed to write frame graph:", error);
    }
  }
};

const compositeScreenshot = async (page: Page, overlay: string) => {
  // Use CDP screenshot - faster, doesn't wait for fonts
  const cdpClient = await getCDPClient(page);
  const client = await cdpClient.acquireSession("screenshot");

  const { data } = await client.send<{ data: string }>(
    "Page.captureScreenshot",
    {
      format: "png",
    }
  );
  const [baseImage, overlayImage] = await Promise.all([
    Jimp.read(Buffer.from(data, "base64")),
    Jimp.read(Buffer.from(overlay, "base64")),
  ]);

  // If dimensions don't match (can happen with viewport: null or DPR), scale overlay to match screenshot
  if (
    overlayImage.bitmap.width !== baseImage.bitmap.width ||
    overlayImage.bitmap.height !== baseImage.bitmap.height
  ) {
    console.log(
      `[Screenshot] Dimension mismatch - overlay: ${overlayImage.bitmap.width}x${overlayImage.bitmap.height}, screenshot: ${baseImage.bitmap.width}x${baseImage.bitmap.height}, scaling overlay...`
    );
    overlayImage.resize({
      w: baseImage.bitmap.width,
      h: baseImage.bitmap.height,
    });
  }

  baseImage.composite(overlayImage, 0, 0);
  const buffer = await baseImage.getBuffer("image/png");
  return buffer.toString("base64");
};

const getActionSchema = (actions: Array<AgentActionDefinition>) => {
  const zodDefs = actions.map((action) =>
    z.object({
      type: z.literal(action.type),
      params: action.actionParams,
      actionDescription: z
        .string()
        .describe(
          "Describe why you are performing this action and what you aim to perform with this action."
        ),
    })
  );
  return z.union([zodDefs[0], zodDefs[1], ...zodDefs.splice(2)] as any);
};

const getActionHandler = (
  actions: Array<AgentActionDefinition>,
  type: string
) => {
  const foundAction = actions.find((actions) => actions.type === type);
  if (foundAction) {
    return foundAction.run;
  } else {
    throw new ActionNotFoundError(type);
  }
};

const DOM_CAPTURE_MAX_ATTEMPTS = 3;
const NAVIGATION_ERROR_SNIPPETS = [
  "Execution context was destroyed",
  "Cannot find context",
  "Target closed",
];

const isRecoverableDomError = (error: unknown): boolean => {
  if (!(error instanceof Error) || !error.message) {
    return false;
  }
  return NAVIGATION_ERROR_SNIPPETS.some((snippet) =>
    error.message.includes(snippet)
  );
};

const isPlaceholderSnapshot = (snapshot: A11yDOMState): boolean => {
  if (snapshot.elements.size > 0) return false;
  return (
    typeof snapshot.domState === "string" &&
    snapshot.domState.startsWith("Error: Could not extract accessibility tree")
  );
};

const runAction = async (
  action: ActionType,
  domState: A11yDOMState,
  page: Page,
  ctx: AgentCtx
): Promise<ActionOutput> => {
  const actionStart = performance.now();
  const actionCtx: ActionContext = {
    domState,
    page,
    tokenLimit: ctx.tokenLimit,
    llm: ctx.llm,
    debugDir: ctx.debugDir,
    debug: ctx.debug,
    mcpClient: ctx.mcpClient || undefined,
    variables: Object.values(ctx.variables),
    actionConfig: ctx.actionConfig,
    invalidateDomCache: () => markDomSnapshotDirty(page),
    featureFlags: ctx.featureFlags,
  };

  if (ctx.actionConfig?.cdpActions) {
    const cdpClient = await getCDPClient(page);
    actionCtx.cdp = {
      resolveElement,
      dispatchCDPAction,
      client: cdpClient,
      preferScriptBoundingBox: !!ctx.debugDir,
      frameContextManager: getOrCreateFrameContextManager(cdpClient),
    };
  }
  const actionType = action.type;
  const actionHandler = getActionHandler(ctx.actions, action.type);
  if (!actionHandler) {
    return {
      success: false,
      message: `Unknown action type: ${actionType}`,
    };
  }
  try {
    const result = await actionHandler(actionCtx, action.params);
    logPerf(ctx.debug, `[Perf][runAction][${action.type}]`, actionStart);
    return result;
  } catch (error) {
    logPerf(ctx.debug, `[Perf][runAction][${action.type}] (error)`, actionStart);
    return {
      success: false,
      message: `Action ${action.type} failed: ${error}`,
    };
  }
};

function logPerf(debug: boolean | undefined, label: string, start: number): void {
  if (!debug) return;
  const duration = performance.now() - start;
  console.log(`${label} took ${Math.round(duration)}ms`);
}

export const runAgentTask = async (
  ctx: AgentCtx,
  taskState: TaskState,
  params?: TaskParams
): Promise<TaskOutput> => {
  const taskStart = performance.now();
  const taskId = taskState.id;
  const debugDir = params?.debugDir || `debug/${taskId}`;

  if (ctx.debug) {
    console.log(`Debugging task ${taskId} in ${debugDir}`);
  }
  if (!taskState) {
    throw new HyperagentError(`Task ${taskId} not found`);
  }

  taskState.status = TaskStatus.RUNNING as TaskStatus;
  if (!ctx.llm) {
    throw new HyperagentError("LLM not initialized");
  }
  // Use the new structured output interface
  const actionSchema = getActionSchema(ctx.actions);

  // V1 always uses visual mode with full system prompt
  const systemPrompt = SYSTEM_PROMPT;

  const baseMsgs: HyperAgentMessage[] = [
    { role: "system", content: systemPrompt },
  ];

  let output = "";
  const page = taskState.startingPage;
  const useDomCache = params?.useDomCache === true;
  const enableDomStreaming = params?.enableDomStreaming === true;
  const navigationDirtyHandler = (): void => {
    markDomSnapshotDirty(page);
  };
  page.on("framenavigated", navigationDirtyHandler);
  page.on("framedetached", navigationDirtyHandler);
  page.on("load", navigationDirtyHandler);

  const cleanupDomListeners = (): void => {
    page.off?.("framenavigated", navigationDirtyHandler);
    page.off?.("framedetached", navigationDirtyHandler);
    page.off?.("load", navigationDirtyHandler);
  };
  let currStep = 0;
  let consecutiveFailuresOrWaits = 0;
  const MAX_CONSECUTIVE_FAILURES_OR_WAITS = 5;
  let lastOverlayKey: string | null = null;
  let lastScreenshotBase64: string | undefined;

  try {
    await ensureFrameContextsReady(page, ctx.debug, params?.featureFlags);
    while (true) {
    // Status Checks
    if ((taskState.status as TaskStatus) == TaskStatus.PAUSED) {
      await sleep(100);
      continue;
    }
    if (endTaskStatuses.has(taskState.status)) {
      break;
    }
    if (params?.maxSteps && currStep >= params.maxSteps) {
      taskState.status = TaskStatus.CANCELLED;
      break;
    }
    const debugStepDir = `${debugDir}/step-${currStep}`;
    const stepStart = performance.now();
    const stepMetrics: Record<string, unknown> = {
      stepIndex: currStep,
    };
    if (ctx.debug) {
      fs.mkdirSync(debugStepDir, { recursive: true });
    }

    // Get A11y DOM State (visual mode optional, default false for performance)
    let domState: A11yDOMState | null = null;
    let domChunks: string | null = null;
    try {
      const domFetchStart = performance.now();
      const captureDomState = async (): Promise<A11yDOMState> => {
        let lastError: unknown;
        for (let attempt = 0; attempt < DOM_CAPTURE_MAX_ATTEMPTS; attempt++) {
          const attemptAggregator = enableDomStreaming
            ? new DomChunkAggregator()
            : null;
          try {
            const snapshot = await getA11yDOM(
              page,
              ctx.debug,
              params?.enableVisualMode ?? false,
              ctx.debug ? debugStepDir : undefined,
              {
                useCache: useDomCache,
                enableStreaming: enableDomStreaming,
                onFrameChunk: attemptAggregator
                  ? (chunk) => attemptAggregator.push(chunk)
                  : undefined,
              }
            );
            if (!snapshot) {
              throw new Error("Failed to capture DOM state");
            }
            if (isPlaceholderSnapshot(snapshot)) {
              lastError = new Error(snapshot.domState);
            } else {
              domChunks = attemptAggregator?.hasContent()
                ? attemptAggregator.toString()
                : null;
              return snapshot;
            }
          } catch (error) {
            if (!isRecoverableDomError(error)) {
              throw error;
            }
            lastError = error;
          }
          if (ctx.debug) {
            console.warn(
              `[DOM] Capture failed (attempt ${attempt + 1}/${DOM_CAPTURE_MAX_ATTEMPTS}), waiting for navigation to settle...`
            );
          }
          await waitForSettledDOM(page).catch(() => {});
        }
        throw lastError ?? new Error("Failed to capture DOM state");
      };

      domState = await captureDomState();
      const domDuration = performance.now() - domFetchStart;
      logPerf(
        ctx.debug,
        `[Perf][runAgentTask] getA11yDOM(step ${currStep})`,
        domFetchStart
      );
      stepMetrics.domCaptureMs = Math.round(domDuration);
    } catch (error) {
      if (ctx.debug) {
        console.log(
          "Failed to retrieve DOM state after 3 retries. Failing task.",
          error
        );
      }
      taskState.status = TaskStatus.FAILED;
      taskState.error = "Failed to retrieve DOM state";
      break;
    }

    if (!domState) {
      taskState.status = TaskStatus.FAILED;
      taskState.error = "Failed to retrieve DOM state";
      break;
    }

    // If visual mode enabled, composite screenshot with overlay
    let trimmedScreenshot: string | undefined;
    if (domState.visualOverlay) {
      const overlayKey = domState.visualOverlay;
      if (overlayKey === lastOverlayKey && lastScreenshotBase64) {
        trimmedScreenshot = lastScreenshotBase64;
      } else {
        trimmedScreenshot = await compositeScreenshot(page, overlayKey);
        lastOverlayKey = overlayKey;
        lastScreenshotBase64 = trimmedScreenshot;
      }
    } else {
      lastOverlayKey = null;
      lastScreenshotBase64 = undefined;
    }

    // Store Dom State for Debugging
    if (ctx.debug) {
      fs.mkdirSync(debugDir, { recursive: true });
      fs.writeFileSync(`${debugStepDir}/elems.txt`, domState.domState);
      if (trimmedScreenshot) {
        fs.writeFileSync(
          `${debugStepDir}/screenshot.png`,
          Buffer.from(trimmedScreenshot, "base64")
        );
      }
    }

    if (domChunks) {
      domState.domState = domChunks;
    }

    // Build Agent Step Messages
    const msgs = await buildAgentStepMessages(
      baseMsgs,
      taskState.steps,
      taskState.task,
      page,
      domState,
      trimmedScreenshot,
      Object.values(ctx.variables)
    );

    // Store Agent Step Messages for Debugging
    if (ctx.debug) {
      fs.writeFileSync(
        `${debugStepDir}/msgs.json`,
        JSON.stringify(msgs, null, 2)
      );
    }

    // Invoke LLM with structured output
    const structuredResult = await retry({
      func: () =>
        (async () => {
          const llmStart = performance.now();
          const result = await ctx.llm.invokeStructured(
            {
              schema: AgentOutputFn(actionSchema),
              options: {
                temperature: 0,
              },
            },
            msgs
          );
          const llmDuration = performance.now() - llmStart;
          logPerf(
            ctx.debug,
            `[Perf][runAgentTask] llm.invokeStructured(step ${currStep})`,
            llmStart
          );
          stepMetrics.llmMs = Math.round(llmDuration);
          return result;
        })(),
    });

    if (!structuredResult.parsed) {
      const providerId = ctx.llm?.getProviderId?.() ?? "unknown-provider";
      const modelId = ctx.llm?.getModelId?.() ?? "unknown-model";
      console.error(
        `[LLM][StructuredOutput] Failed to parse response from ${providerId} (${modelId}). Raw response: ${
          structuredResult.rawText?.trim() || "<empty>"
        }`
      );
      throw new Error("Failed to get structured output from LLM");
    }

    const agentOutput = structuredResult.parsed;

    params?.debugOnAgentOutput?.(agentOutput);

    // Status Checks
    if ((taskState.status as TaskStatus) == TaskStatus.PAUSED) {
      await sleep(100);
      continue;
    }
    if (endTaskStatuses.has(taskState.status)) {
      break;
    }

    // Run single action
    const action = agentOutput.action;

    // Handle complete action specially
    if (action.type === "complete") {
      taskState.status = TaskStatus.COMPLETED;
      const actionDefinition = ctx.actions.find(
        (actionDefinition) => actionDefinition.type === "complete"
      );
      if (actionDefinition) {
        output =
          (await actionDefinition.completeAction?.(action.params)) ??
          "No complete action found";
      } else {
        output = "No complete action found";
      }
    }

    // Execute the action
    const actionExecStart = performance.now();
    const actionOutput = await runAction(action, domState, page, ctx);
    const actionDuration = performance.now() - actionExecStart;
    logPerf(
      ctx.debug,
      `[Perf][runAgentTask] runAction(step ${currStep})`,
      actionExecStart
    );
    stepMetrics.actionMs = Math.round(actionDuration);
    stepMetrics.actionType = action.type;
    stepMetrics.actionSuccess = actionOutput.success;
    if (
      actionOutput.debug &&
      typeof actionOutput.debug === "object" &&
      "timings" in actionOutput.debug &&
      actionOutput.debug.timings &&
      typeof actionOutput.debug.timings === "object"
    ) {
      stepMetrics.actionTimings = actionOutput.debug.timings;
    }
    if (!READ_ONLY_ACTIONS.has(action.type)) {
      markDomSnapshotDirty(page);
    }

    // Check action result and handle retry logic
    if (action.type === "wait") {
      // Wait action - increment counter
      consecutiveFailuresOrWaits++;

      if (consecutiveFailuresOrWaits >= MAX_CONSECUTIVE_FAILURES_OR_WAITS) {
        taskState.status = TaskStatus.FAILED;
        taskState.error = `Agent is stuck: waited or failed ${MAX_CONSECUTIVE_FAILURES_OR_WAITS} consecutive times without making progress.`;

        const step: AgentStep = {
          idx: currStep,
          agentOutput: agentOutput,
          actionOutput,
        };
        taskState.steps.push(step);
        await params?.onStep?.(step);
        break;
      }

      if (ctx.debug) {
        console.log(
          `[agent] Wait action (${consecutiveFailuresOrWaits}/${MAX_CONSECUTIVE_FAILURES_OR_WAITS}): ${actionOutput.message}`
        );
      }
    } else if (!actionOutput.success) {
      // Action failed - increment counter
      consecutiveFailuresOrWaits++;

      if (consecutiveFailuresOrWaits >= MAX_CONSECUTIVE_FAILURES_OR_WAITS) {
        taskState.status = TaskStatus.FAILED;
        taskState.error = `Agent is stuck: waited or failed ${MAX_CONSECUTIVE_FAILURES_OR_WAITS} consecutive times without making progress. Last error: ${actionOutput.message}`;

        const step: AgentStep = {
          idx: currStep,
          agentOutput: agentOutput,
          actionOutput,
        };
        taskState.steps.push(step);
        await params?.onStep?.(step);
        break;
      }

      if (ctx.debug) {
        console.log(
          `[agent] Action failed (${consecutiveFailuresOrWaits}/${MAX_CONSECUTIVE_FAILURES_OR_WAITS}): ${actionOutput.message}`
        );
      }
    } else {
      // Success - reset counter
      consecutiveFailuresOrWaits = 0;
    }

    // Wait for DOM to settle after action
    const waitStats = await waitForSettledDOM(page);
    stepMetrics.waitForSettledMs = Math.round(waitStats.durationMs);
    stepMetrics.waitForSettled = {
      totalMs: Math.round(waitStats.durationMs),
      lifecycleMs: Math.round(waitStats.lifecycleMs),
      networkMs: Math.round(waitStats.networkMs),
      requestsSeen: waitStats.requestsSeen,
      peakInflight: waitStats.peakInflight,
      reason: waitStats.resolvedByTimeout ? "timeout" : "quiet",
      forcedDrops: waitStats.forcedDrops,
    };

    const step: AgentStep = {
      idx: currStep,
      agentOutput,
      actionOutput,
    };
    taskState.steps.push(step);
    await params?.onStep?.(step);
    currStep = currStep + 1;
    const totalDuration = performance.now() - stepStart;
    logPerf(
      ctx.debug,
      `[Perf][runAgentTask] step ${currStep - 1} total`,
      stepStart
    );
    stepMetrics.totalMs = Math.round(totalDuration);

    if (ctx.debug) {
      await writeFrameGraphSnapshot(page, debugStepDir, ctx.debug);
      fs.writeFileSync(
        `${debugStepDir}/stepOutput.json`,
        JSON.stringify(step, null, 2)
      );
      fs.writeFileSync(
        `${debugStepDir}/perf.json`,
        JSON.stringify(stepMetrics, null, 2)
      );
    }
  }

  logPerf(
    ctx.debug,
    `[Perf][runAgentTask] Task ${taskId}`,
    taskStart
  );

  }
  finally {
    cleanupDomListeners();
  }

  const taskOutput: TaskOutput = {
    status: taskState.status,
    steps: taskState.steps,
    output,
  };
  if (ctx.debug) {
    fs.writeFileSync(
      `${debugDir}/taskOutput.json`,
      JSON.stringify(taskOutput, null, 2)
    );
  }
  await params?.onComplete?.(taskOutput);
  return taskOutput;
};
