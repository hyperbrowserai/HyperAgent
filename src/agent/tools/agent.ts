import { AgentStep } from "@/types/agent/types";
import fs from "fs";

import { performance } from "perf_hooks";
import {
  ActionContext,
  ActionOutput,
  ActionType,
  AgentActionDefinition,
} from "@/types";
import { markDomSnapshotDirty } from "@/context-providers/a11y-dom/dom-cache";
import {
  resolveElement,
  dispatchCDPAction,
  getCDPClient,
  getOrCreateFrameContextManager,
} from "@/cdp";
import { retry } from "@/utils/retry";
import { sleep } from "@/utils/sleep";
import { waitForSettledDOM } from "@/utils/waitForSettledDOM";
import { captureDOMState } from "../shared/dom-capture";
import { initializeRuntimeContext } from "../shared/runtime-context";

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

// DomChunkAggregator logic moved to shared/dom-capture.ts

const READ_ONLY_ACTIONS = new Set(["wait", "extract", "complete"]);

const writeFrameGraphSnapshot = async (
  page: Page,
  dir: string,
  debug?: boolean
): Promise<void> => {
  try {
    const cdpClient = await getCDPClient(page);
    const frameManager = getOrCreateFrameContextManager(cdpClient);
    frameManager.setDebug(debug);
    const data = frameManager.toJSON();
    fs.writeFileSync(`${dir}/frames.json`, JSON.stringify(data, null, 2));
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
    })
  );

  if (zodDefs.length === 0) {
    throw new Error("No actions registered for agent");
  }

  if (zodDefs.length === 1) {
    const [single] = zodDefs;
    const schema = z.union([single, single] as [z.ZodTypeAny, z.ZodTypeAny]);
    return schema;
  }

  const [first, second, ...rest] = zodDefs;
  const schema = z.union([first, second, ...rest] as [
    z.ZodTypeAny,
    z.ZodTypeAny,
    ...z.ZodTypeAny[],
  ]);
  return schema;
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
    cdpActions: ctx.cdpActions,
    invalidateDomCache: () => markDomSnapshotDirty(page),
  };

  if (ctx.cdpActions) {
    const { cdpClient, frameContextManager } = await initializeRuntimeContext(page, ctx.debug);
    actionCtx.cdp = {
      resolveElement,
      dispatchCDPAction,
      client: cdpClient,
      preferScriptBoundingBox: !!ctx.debugDir,
      frameContextManager,
      debug: ctx.debug,
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
    logPerf(
      ctx.debug,
      `[Perf][runAction][${action.type}] (error)`,
      actionStart
    );
    return {
      success: false,
      message: `Action ${action.type} failed: ${error}`,
    };
  }
};

function logPerf(
  debug: boolean | undefined,
  label: string,
  start: number
): void {
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
  
  // Track schema validation errors across steps
  if (!ctx.schemaErrors) {
    ctx.schemaErrors = [];
  }
  
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
    // Initialize context at the start of the task
    await initializeRuntimeContext(page, ctx.debug);
    
    while (true) {
      // Status Checks
      const status: TaskStatus = taskState.status;
      if (status === TaskStatus.PAUSED) {
        await sleep(100);
        continue;
      }
      if (endTaskStatuses.has(status)) {
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
      const domChunks: string | null = null;
      try {
        const domFetchStart = performance.now();
        
        domState = await captureDOMState(page, {
          useCache: useDomCache,
          debug: ctx.debug,
          enableVisualMode: params?.enableVisualMode ?? false,
          debugStepDir: ctx.debug ? debugStepDir : undefined,
          enableStreaming: enableDomStreaming,
          onFrameChunk: enableDomStreaming ? () => {
            // captureDOMState handles aggregation
          } : undefined
        });

        const domDuration = performance.now() - domFetchStart;
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
      let msgs = await buildAgentStepMessages(
        baseMsgs,
        taskState.steps,
        taskState.task,
        page,
        domState,
        trimmedScreenshot,
        Object.values(ctx.variables)
      );
      
      // Append accumulated schema errors from previous steps
      if (ctx.schemaErrors && ctx.schemaErrors.length > 0) {
        const errorSummary = ctx.schemaErrors
          .slice(-3) // Only keep last 3 errors to avoid context bloat
          .map(err => `Step ${err.stepIndex}: ${err.error}`)
          .join('\n');
        
        msgs = [
          ...msgs,
          {
            role: "user",
            content: `Note: Previous steps had schema validation errors. Learn from these:\n${errorSummary}\n\nEnsure your response follows the exact schema structure.`,
          },
        ];
      }

      // Store Agent Step Messages for Debugging
      if (ctx.debug) {
        fs.writeFileSync(
          `${debugStepDir}/msgs.json`,
          JSON.stringify(msgs, null, 2)
        );
      }

      // Invoke LLM with structured output
      const agentOutput = await (async () => {
        const maxAttempts = 3;
        let currentMsgs = msgs;
        
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
                    actions: ctx.actions,
                  },
                  currentMsgs
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
            onError: (...args: Array<unknown>) => {
              console.error("[LLM][StructuredOutput] Retry error", ...args);
            },
          });

          if (structuredResult.parsed) {
            return structuredResult.parsed;
          }

          const providerId = ctx.llm?.getProviderId?.() ?? "unknown-provider";
          const modelId = ctx.llm?.getModelId?.() ?? "unknown-model";
          
          // Try to get detailed Zod validation error
          let validationError = "Unknown validation error";
          if (structuredResult.rawText) {
            try {
              const parsed = JSON.parse(structuredResult.rawText);
              AgentOutputFn(actionSchema).parse(parsed);
            } catch (zodError) {
              if (zodError instanceof z.ZodError) {
                validationError = JSON.stringify(zodError.issues, null, 2);
              } else {
                validationError = String(zodError);
              }
            }
          }
          
          console.error(
            `[LLM][StructuredOutput] Failed to parse response from ${providerId} (${modelId}). Raw response: ${
              structuredResult.rawText?.trim() || "<empty>"
            } (attempt ${attempt + 1}/${maxAttempts})`
          );
          
          // Store error for cross-step learning
          ctx.schemaErrors?.push({
            stepIndex: currStep,
            error: validationError,
            rawResponse: structuredResult.rawText || "",
          });
          
          // Append error feedback for next retry
          if (attempt < maxAttempts - 1) {
            currentMsgs = [
              ...currentMsgs,
              {
                role: "assistant",
                content: structuredResult.rawText || "Failed to generate response",
              },
              {
                role: "user",
                content: `The previous response failed validation. Zod validation errors:\n\`\`\`json\n${validationError}\n\`\`\`\n\nPlease fix these errors and return valid structured output matching the schema.`,
              },
            ];
          }
        }
        throw new Error("Failed to get structured output from LLM");
      })();

      params?.debugOnAgentOutput?.(agentOutput);

      // Status Checks
      const statusAfterLLM: TaskStatus = taskState.status;
      if (statusAfterLLM === TaskStatus.PAUSED) {
        await sleep(100);
        continue;
      }
      if (endTaskStatuses.has(statusAfterLLM)) {
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

    logPerf(ctx.debug, `[Perf][runAgentTask] Task ${taskId}`, taskStart);
  } finally {
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
