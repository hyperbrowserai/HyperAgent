import {
  ActionCacheOutput,
  AgentStep,
  AgentTaskOutput,
} from "@/types/agent/types";
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
import { formatUnknownError } from "@/utils";
import { retry } from "@/utils/retry";
import { sleep } from "@/utils/sleep";
import { waitForSettledDOM } from "@/utils/waitForSettledDOM";
import { captureDOMState } from "../shared/dom-capture";
import { initializeRuntimeContext } from "../shared/runtime-context";

import { AgentOutputFn, endTaskStatuses } from "@/types";
import { TaskParams, TaskState, TaskStatus } from "@/types";

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
import { buildActionCacheEntry } from "../shared/action-cache";

// DomChunkAggregator logic moved to shared/dom-capture.ts

const READ_ONLY_ACTIONS = new Set(["wait", "extract", "complete"]);
const MAX_REPEATED_ACTIONS_WITHOUT_PROGRESS = 4;
const MAX_STRUCTURED_DIAGNOSTIC_PARSE_CHARS = 100_000;
const MAX_STRUCTURED_DIAGNOSTIC_ERROR_CHARS = 4_000;
const MAX_STRUCTURED_DIAGNOSTIC_RAW_RESPONSE_CHARS = 8_000;
const MAX_STRUCTURED_DIAGNOSTIC_IDENTIFIER_CHARS = 120;
const MAX_SCHEMA_ERROR_SUMMARY_CHARS = 3_000;
const MAX_SCHEMA_ERROR_HISTORY = 20;
const MAX_RUNTIME_ACTION_TYPE_CHARS = 120;
const MAX_RUNTIME_ACTION_MESSAGE_CHARS = 4_000;
const MAX_RUNTIME_URL_CHARS = 1_000;
const MAX_RUNTIME_TASK_OUTPUT_CHARS = 20_000;
const MAX_DOM_PROGRESS_SIGNATURE_CHARS = 800;

function truncateDiagnosticText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const omittedChars = value.length - maxChars;
  return `${value.slice(0, maxChars)}... [truncated ${omittedChars} chars]`;
}

function sanitizeDiagnosticText(value: string): string {
  if (value.length === 0) {
    return value;
  }
  const withoutControlChars = Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code < 32) || code === 127 ? " " : char;
  }).join("");
  return withoutControlChars.replace(/\s+/g, " ").trim();
}

function formatDiagnosticText(
  value: unknown,
  maxChars: number,
  fallback: string
): string {
  const raw = typeof value === "string" ? value : formatUnknownError(value);
  const normalized = sanitizeDiagnosticText(raw);
  if (normalized.length === 0) {
    return fallback;
  }
  return truncateDiagnosticText(normalized, maxChars);
}

function formatDiagnosticIdentifier(value: unknown, fallback: string): string {
  return formatDiagnosticText(
    value,
    MAX_STRUCTURED_DIAGNOSTIC_IDENTIFIER_CHARS,
    fallback
  );
}

function safeReadRecordField(value: unknown, key: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function normalizeRuntimeActionType(value: unknown): string {
  return formatDiagnosticText(
    value,
    MAX_RUNTIME_ACTION_TYPE_CHARS,
    "unknown"
  );
}

function normalizeRuntimeActionMessage(value: unknown): string {
  return formatDiagnosticText(
    value,
    MAX_RUNTIME_ACTION_MESSAGE_CHARS,
    "Action failed without an error message."
  );
}

function normalizeTaskOutputText(value: unknown, fallback: string): string {
  const raw =
    typeof value === "string"
      ? value
      : value == null
        ? fallback
        : formatUnknownError(value);
  const normalized = raw.replace(/\r\n?/g, "\n").trim();
  if (normalized.length === 0) {
    return fallback;
  }
  return truncateDiagnosticText(normalized, MAX_RUNTIME_TASK_OUTPUT_CHARS);
}

function safeGetPageUrl(page: Page): string {
  try {
    const url = page.url();
    if (typeof url !== "string") {
      return "about:blank";
    }
    const normalized = url.replace(/\s+/g, " ").trim();
    if (normalized.length === 0) {
      return "about:blank";
    }
    return truncateDiagnosticText(normalized, MAX_RUNTIME_URL_CHARS);
  } catch {
    return "about:blank";
  }
}

function buildDomProgressSignature(domState: A11yDOMState): string {
  const rawDomState = safeReadRecordField(domState, "domState");
  const normalized = formatDiagnosticText(
    rawDomState,
    MAX_DOM_PROGRESS_SIGNATURE_CHARS,
    "DOM state unavailable"
  );
  if (normalized.length <= MAX_DOM_PROGRESS_SIGNATURE_CHARS) {
    return normalized;
  }
  return truncateDiagnosticText(normalized, MAX_DOM_PROGRESS_SIGNATURE_CHARS);
}

function normalizeWaitStats(value: unknown): {
  durationMs: number;
  lifecycleMs: number;
  networkMs: number;
  requestsSeen: number;
  peakInflight: number;
  resolvedByTimeout: boolean;
  forcedDrops: number;
} {
  if (!value || typeof value !== "object") {
    return {
      durationMs: 0,
      lifecycleMs: 0,
      networkMs: 0,
      requestsSeen: 0,
      peakInflight: 0,
      resolvedByTimeout: false,
      forcedDrops: 0,
    };
  }
  const readNumber = (key: string): number => {
    const field = safeReadRecordField(value, key);
    if (typeof field !== "number" || !Number.isFinite(field)) {
      return 0;
    }
    return field;
  };
  return {
    durationMs: readNumber("durationMs"),
    lifecycleMs: readNumber("lifecycleMs"),
    networkMs: readNumber("networkMs"),
    requestsSeen: readNumber("requestsSeen"),
    peakInflight: readNumber("peakInflight"),
    resolvedByTimeout: safeReadRecordField(value, "resolvedByTimeout") === true,
    forcedDrops: readNumber("forcedDrops"),
  };
}

function normalizeActionOutput(
  value: unknown,
  actionType: string
): ActionOutput {
  if (!value || typeof value !== "object") {
    return {
      success: false,
      message: `Action ${actionType} returned invalid output: ${normalizeRuntimeActionMessage(
        value
      )}`,
    };
  }
  const success = safeReadRecordField(value, "success") === true;
  const message = normalizeRuntimeActionMessage(
    safeReadRecordField(value, "message")
  );
  const extract = safeReadRecordField(value, "extract");
  const debug = safeReadRecordField(value, "debug");
  return {
    success,
    message,
    ...(extract !== undefined ? { extract: extract as object } : {}),
    ...(debug !== undefined ? { debug } : {}),
  };
}

function resolveCompleteActionFormatter(
  actions: Array<AgentActionDefinition>
):
  | ((params: unknown) => Promise<string> | string)
  | null {
  for (const actionDefinition of actions) {
    if (
      normalizeRuntimeActionType(safeReadRecordField(actionDefinition, "type")) !==
      "complete"
    ) {
      continue;
    }
    const completeAction = safeReadRecordField(actionDefinition, "completeAction");
    if (typeof completeAction === "function") {
      return completeAction as (params: unknown) => Promise<string> | string;
    }
    return null;
  }
  return null;
}

function getContextVariables(ctx: AgentCtx): ActionContext["variables"] {
  const rawVariables = safeReadRecordField(ctx, "variables");
  if (!rawVariables || typeof rawVariables !== "object") {
    return [];
  }
  try {
    return Object.values(
      rawVariables as Record<string, ActionContext["variables"][number]>
    );
  } catch {
    return [];
  }
}

function safeJsonStringify(value: unknown, spacing: number = 2): string {
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(
      value,
      (_key, candidate: unknown) => {
        if (typeof candidate === "bigint") {
          return `${candidate.toString()}n`;
        }
        if (typeof candidate === "object" && candidate !== null) {
          if (seen.has(candidate)) {
            return "[Circular]";
          }
          seen.add(candidate);
        }
        return candidate;
      },
      spacing
    );
    if (typeof serialized === "string") {
      return serialized;
    }
  } catch {
    // fall through to fallback payload
  }

  return JSON.stringify(
    {
      __nonSerializable: formatDiagnosticText(
        value,
        MAX_RUNTIME_ACTION_MESSAGE_CHARS,
        "non-serializable value"
      ),
    },
    null,
    spacing
  );
}

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
    fs.writeFileSync(`${dir}/frames.json`, safeJsonStringify(data));
  } catch (error) {
    if (debug) {
      console.warn(
        `[FrameContext] Failed to write frame graph: ${formatDiagnosticText(
          error,
          MAX_RUNTIME_ACTION_MESSAGE_CHARS,
          "unknown error"
        )}`
      );
    }
  }
};

const ensureDirectorySafe = (dir: string, debug?: boolean): boolean => {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (error) {
    if (debug) {
      console.error(
        `[DebugIO] Failed to create directory "${dir}": ${formatDiagnosticText(
          error,
          MAX_RUNTIME_ACTION_MESSAGE_CHARS,
          "unknown error"
        )}`
      );
    }
    return false;
  }
};

const writeDebugFileSafe = (
  filePath: string,
  content: string | Buffer,
  debug?: boolean
): void => {
  try {
    fs.writeFileSync(filePath, content);
  } catch (error) {
    if (debug) {
      console.error(
        `[DebugIO] Failed to write file "${filePath}": ${formatDiagnosticText(
          error,
          MAX_RUNTIME_ACTION_MESSAGE_CHARS,
          "unknown error"
        )}`
      );
    }
  }
};

const compositeScreenshot = async (
  page: Page,
  overlay: string,
  debug?: boolean
) => {
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
    if (debug) {
      console.log(
        `[Screenshot] Dimension mismatch - overlay: ${overlayImage.bitmap.width}x${overlayImage.bitmap.height}, screenshot: ${baseImage.bitmap.width}x${baseImage.bitmap.height}, scaling overlay...`
      );
    }
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
  const zodDefs: z.ZodObject<{
    type: z.ZodLiteral<string>;
    params: z.ZodTypeAny;
  }>[] = [];
  for (const action of actions) {
    const actionType = normalizeRuntimeActionType(
      safeReadRecordField(action, "type")
    );
    const actionParams = safeReadRecordField(action, "actionParams");
    if (actionType === "unknown") {
      continue;
    }
    if (
      !actionParams ||
      typeof actionParams !== "object" ||
      typeof safeReadRecordField(actionParams, "safeParse") !== "function"
    ) {
      continue;
    }
    zodDefs.push(
      z.object({
        type: z.literal(actionType),
        params: actionParams as z.ZodTypeAny,
      })
    );
  }

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
  const normalizedType = normalizeRuntimeActionType(type);
  for (const action of actions) {
    const actionType = normalizeRuntimeActionType(
      safeReadRecordField(action, "type")
    );
    if (actionType !== normalizedType) {
      continue;
    }
    const run = safeReadRecordField(action, "run");
    if (typeof run !== "function") {
      throw new Error(`Action ${normalizedType} is missing a runnable handler.`);
    }
    return run as AgentActionDefinition["run"];
  }
  throw new ActionNotFoundError(normalizedType);
};

const runAction = async (
  action: ActionType,
  domState: A11yDOMState,
  page: Page,
  ctx: AgentCtx
): Promise<ActionOutput> => {
  const actionStart = performance.now();
  const actionType = normalizeRuntimeActionType(safeReadRecordField(action, "type"));
  const actionParams = safeReadRecordField(action, "params");
  const actionCtx: ActionContext = {
    domState,
    page,
    tokenLimit: ctx.tokenLimit,
    llm: ctx.llm,
    debugDir: ctx.debugDir,
    debug: ctx.debug,
    mcpClient: ctx.mcpClient || undefined,
    variables: getContextVariables(ctx),
    cdpActions: ctx.cdpActions,
    invalidateDomCache: () => markDomSnapshotDirty(page),
  };

  let actionHandler: AgentActionDefinition["run"];
  try {
    actionHandler = getActionHandler(ctx.actions, actionType);
  } catch (error) {
    logPerf(
      ctx.debug,
      `[Perf][runAction][${actionType}] (handler error)`,
      actionStart
    );
    return {
      success: false,
      message: `Action ${actionType} failed: ${normalizeRuntimeActionMessage(error)}`,
    };
  }

  if (ctx.cdpActions) {
    try {
      const { cdpClient, frameContextManager } = await initializeRuntimeContext(
        page,
        ctx.debug
      );
      actionCtx.cdp = {
        resolveElement,
        dispatchCDPAction,
        client: cdpClient,
        preferScriptBoundingBox: !!ctx.debugDir,
        frameContextManager,
        debug: ctx.debug,
      };
    } catch (error) {
      logPerf(
        ctx.debug,
        `[Perf][runAction][${actionType}] (cdp init error)`,
        actionStart
      );
      return {
        success: false,
        message: `Action ${actionType} failed: ${normalizeRuntimeActionMessage(
          error
        )}`,
      };
    }
  }

  try {
    const result = await actionHandler(actionCtx, actionParams);
    logPerf(ctx.debug, `[Perf][runAction][${actionType}]`, actionStart);
    return normalizeActionOutput(result, actionType);
  } catch (error) {
    logPerf(
      ctx.debug,
      `[Perf][runAction][${actionType}] (error)`,
      actionStart
    );
    return {
      success: false,
      message: `Action ${actionType} failed: ${normalizeRuntimeActionMessage(
        error
      )}`,
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
): Promise<AgentTaskOutput> => {
  if (!taskState || typeof taskState !== "object") {
    throw new HyperagentError("Task state not found");
  }
  const taskStart = performance.now();
  const taskId = taskState.id;
  const debugDir = params?.debugDir || `debug/${taskId}`;
  let debugArtifactsEnabled = Boolean(ctx.debug);

  if (ctx.debug) {
    console.log(`Debugging task ${taskId} in ${debugDir}`);
  }
  if (debugArtifactsEnabled) {
    debugArtifactsEnabled = ensureDirectorySafe(debugDir, ctx.debug);
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
  let page = taskState.startingPage;
  const useDomCache = params?.useDomCache === true;
  const enableDomStreaming = params?.enableDomStreaming === true;

  // Track schema validation errors across steps
  if (!ctx.schemaErrors) {
    ctx.schemaErrors = [];
  }

  const navigationDirtyHandler = (): void => {
    markDomSnapshotDirty(page);
  };

  const setupDomListeners = (p: Page) => {
    const on = safeReadRecordField(p, "on");
    if (typeof on !== "function") {
      return;
    }
    try {
      on.call(p, "framenavigated", navigationDirtyHandler);
      on.call(p, "framedetached", navigationDirtyHandler);
      on.call(p, "load", navigationDirtyHandler);
    } catch (error) {
      if (ctx.debug) {
        console.warn(
          `[Agent] Failed to attach DOM listeners: ${normalizeRuntimeActionMessage(
            error
          )}`
        );
      }
    }
  };

  const cleanupDomListeners = (p: Page) => {
    const off = safeReadRecordField(p, "off");
    if (typeof off !== "function") {
      return;
    }
    try {
      off.call(p, "framenavigated", navigationDirtyHandler);
      off.call(p, "framedetached", navigationDirtyHandler);
      off.call(p, "load", navigationDirtyHandler);
    } catch (error) {
      if (ctx.debug) {
        console.warn(
          `[Agent] Failed to detach DOM listeners: ${normalizeRuntimeActionMessage(
            error
          )}`
        );
      }
    }
  };

  setupDomListeners(page);
  let currStep = 0;
  let consecutiveFailuresOrWaits = 0;
  const MAX_CONSECUTIVE_FAILURES_OR_WAITS = 5;
  let lastSuccessfulProgressFingerprint: string | null = null;
  let consecutiveRepeatedSuccessfulActions = 0;
  let lastOverlayKey: string | null = null;
  let lastScreenshotBase64: string | undefined;
  const actionCacheSteps: ActionCacheOutput["steps"] = [];

  try {
    // Initialize context at the start of the task
    let runtimeContextReady = true;
    try {
      await initializeRuntimeContext(page, ctx.debug);
    } catch (error) {
      runtimeContextReady = false;
      const initError = `Failed to initialize runtime context: ${normalizeRuntimeActionMessage(
        error
      )}`;
      taskState.status = TaskStatus.FAILED;
      taskState.error = initError;
      output = initError;
    }

    while (runtimeContextReady) {
      // Check for page context switch
      if (ctx.activePage) {
        const newPage = await ctx.activePage();
        if (newPage && newPage !== page) {
          if (ctx.debug) {
            console.log(
              `[Agent] Switching active page context to ${safeGetPageUrl(newPage)}`
            );
          }
          cleanupDomListeners(page);
          page = newPage;
          setupDomListeners(page);
          try {
            await initializeRuntimeContext(page, ctx.debug);
          } catch (error) {
            const switchError = `Failed to initialize runtime context for switched page: ${normalizeRuntimeActionMessage(
              error
            )}`;
            taskState.status = TaskStatus.FAILED;
            taskState.error = switchError;
            output = switchError;
            break;
          }
          markDomSnapshotDirty(page);
        }
      }

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
      const stepDebugArtifactsEnabled =
        debugArtifactsEnabled && ensureDirectorySafe(debugStepDir, ctx.debug);

      // Get A11y DOM State (visual mode optional, default false for performance)
      let domState: A11yDOMState | null = null;
      try {
        const domFetchStart = performance.now();

        await waitForSettledDOM(page);
        domState = await captureDOMState(page, {
          useCache: useDomCache,
          debug: ctx.debug,
          enableVisualMode: params?.enableVisualMode ?? false,
          debugStepDir: stepDebugArtifactsEnabled ? debugStepDir : undefined,
          enableStreaming: enableDomStreaming,
          onFrameChunk: enableDomStreaming
            ? () => {
                // captureDOMState handles aggregation
              }
            : undefined,
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
          try {
            trimmedScreenshot = await compositeScreenshot(
              page,
              overlayKey,
              ctx.debug
            );
            lastOverlayKey = overlayKey;
            lastScreenshotBase64 = trimmedScreenshot;
          } catch (error) {
            if (ctx.debug) {
              console.warn(
                "[Screenshot] Failed to compose overlay screenshot; continuing without visual image:",
                formatDiagnosticText(
                  error,
                  MAX_RUNTIME_ACTION_MESSAGE_CHARS,
                  "unknown error"
                )
              );
            }
            trimmedScreenshot = undefined;
            lastOverlayKey = null;
            lastScreenshotBase64 = undefined;
          }
        }
      } else {
        lastOverlayKey = null;
        lastScreenshotBase64 = undefined;
      }

      // Store Dom State for Debugging
      if (stepDebugArtifactsEnabled) {
        writeDebugFileSafe(`${debugStepDir}/elems.txt`, domState.domState, ctx.debug);
        if (trimmedScreenshot) {
          writeDebugFileSafe(
            `${debugStepDir}/screenshot.png`,
            Buffer.from(trimmedScreenshot, "base64"),
            ctx.debug
          );
        }
      }

      // Build Agent Step Messages
      let msgs = await buildAgentStepMessages(
        baseMsgs,
        taskState.steps,
        taskState.task,
        page,
        domState,
        trimmedScreenshot,
        getContextVariables(ctx)
      );

      // Append accumulated schema errors from previous steps
      if (ctx.schemaErrors && ctx.schemaErrors.length > 0) {
        const errorSummary = truncateDiagnosticText(
          ctx.schemaErrors
            .slice(-3) // Only keep last 3 errors to avoid context bloat
            .map((err) => `Step ${err.stepIndex}: ${err.error}`)
            .join("\n"),
          MAX_SCHEMA_ERROR_SUMMARY_CHARS
        );

        msgs = [
          ...msgs,
          {
            role: "user",
            content: `Note: Previous steps had schema validation errors. Learn from these:\n${errorSummary}\n\nEnsure your response follows the exact schema structure.`,
          },
        ];
      }

      // Store Agent Step Messages for Debugging
      if (stepDebugArtifactsEnabled) {
        writeDebugFileSafe(
          `${debugStepDir}/msgs.json`,
          safeJsonStringify(msgs),
          ctx.debug
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
              const [attemptLabel, failure] = args;
              const safeAttemptLabel = formatDiagnosticText(
                attemptLabel,
                MAX_STRUCTURED_DIAGNOSTIC_IDENTIFIER_CHARS,
                "retry"
              );
              const safeFailure = formatDiagnosticText(
                failure,
                MAX_STRUCTURED_DIAGNOSTIC_ERROR_CHARS,
                "unknown error"
              );
              console.error(
                `[LLM][StructuredOutput] Retry error ${safeAttemptLabel}: ${safeFailure}`
              );
            },
          });

          if (structuredResult.parsed) {
            return structuredResult.parsed;
          }

          const providerId = formatDiagnosticIdentifier(
            ctx.llm?.getProviderId?.(),
            "unknown-provider"
          );
          const modelId = formatDiagnosticIdentifier(
            ctx.llm?.getModelId?.(),
            "unknown-model"
          );

          // Try to get detailed Zod validation error
          let validationError = "Unknown validation error";
          if (structuredResult.rawText) {
            try {
              if (
                structuredResult.rawText.length >
                MAX_STRUCTURED_DIAGNOSTIC_PARSE_CHARS
              ) {
                validationError = `Response exceeded ${MAX_STRUCTURED_DIAGNOSTIC_PARSE_CHARS} characters and was skipped for validation diagnostics`;
                throw new Error(validationError);
              }

              const normalizedRawText = structuredResult.rawText.replace(
                /^\uFEFF/,
                ""
              );
              const parsed = JSON.parse(normalizedRawText);
              AgentOutputFn(actionSchema).parse(parsed);
            } catch (zodError) {
              if (zodError instanceof z.ZodError) {
                validationError = JSON.stringify(zodError.issues, null, 2);
              } else if (
                zodError instanceof Error &&
                zodError.message === validationError
              ) {
                validationError = zodError.message;
              } else {
                validationError = formatDiagnosticText(
                  zodError,
                  MAX_STRUCTURED_DIAGNOSTIC_ERROR_CHARS,
                  "unknown error"
                );
              }
            }
          }

          const rawResponseForLog = truncateDiagnosticText(
            structuredResult.rawText?.trim() || "<empty>",
            MAX_STRUCTURED_DIAGNOSTIC_RAW_RESPONSE_CHARS
          );
          const validationErrorForPrompt = truncateDiagnosticText(
            validationError,
            MAX_STRUCTURED_DIAGNOSTIC_ERROR_CHARS
          );
          const rawResponseForPrompt = truncateDiagnosticText(
            structuredResult.rawText || "Failed to generate response",
            MAX_STRUCTURED_DIAGNOSTIC_RAW_RESPONSE_CHARS
          );

          console.error(
            `[LLM][StructuredOutput] Failed to parse response from ${providerId} (${modelId}). Raw response: ${
              rawResponseForLog
            } (attempt ${attempt + 1}/${maxAttempts})`
          );

          // Store error for cross-step learning
          if (ctx.schemaErrors) {
            ctx.schemaErrors.push({
              stepIndex: currStep,
              error: validationErrorForPrompt,
              rawResponse: truncateDiagnosticText(
                structuredResult.rawText || "",
                MAX_STRUCTURED_DIAGNOSTIC_RAW_RESPONSE_CHARS
              ),
            });
            if (ctx.schemaErrors.length > MAX_SCHEMA_ERROR_HISTORY) {
              ctx.schemaErrors.splice(
                0,
                ctx.schemaErrors.length - MAX_SCHEMA_ERROR_HISTORY
              );
            }
          }

          // Append error feedback for next retry
          if (attempt < maxAttempts - 1) {
            currentMsgs = [
              ...currentMsgs,
              {
                role: "assistant",
                content: rawResponseForPrompt,
              },
              {
                role: "user",
                content: `The previous response failed validation. Zod validation errors:\n\`\`\`json\n${validationErrorForPrompt}\n\`\`\`\n\nPlease fix these errors and return valid structured output matching the schema.`,
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
      const actionType = normalizeRuntimeActionType(
        safeReadRecordField(action, "type")
      );
      const actionParams = safeReadRecordField(action, "params");

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
      stepMetrics.actionType = actionType;
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
      if (!READ_ONLY_ACTIONS.has(actionType)) {
        markDomSnapshotDirty(page);
      }

      const actionCacheEntry = buildActionCacheEntry({
        stepIndex: currStep,
        action,
        actionOutput,
        domState,
      });
      actionCacheSteps.push(actionCacheEntry);

      if (actionType === "complete") {
        if (actionOutput.success) {
          const completeFormatter = resolveCompleteActionFormatter(ctx.actions);
          const fallbackCompleteOutput = normalizeTaskOutputText(
            actionOutput.message,
            "Task Complete"
          );
          if (completeFormatter) {
            try {
              output = normalizeTaskOutputText(
                await completeFormatter(actionParams),
                fallbackCompleteOutput
              );
            } catch (error) {
              if (ctx.debug) {
                console.warn(
                  `[Agent] completeAction formatter failed: ${normalizeRuntimeActionMessage(
                    error
                  )}`
                );
              }
              output = fallbackCompleteOutput;
            }
          } else {
            output = fallbackCompleteOutput;
          }
          taskState.status = TaskStatus.COMPLETED;
        } else {
          taskState.status = TaskStatus.FAILED;
          taskState.error = normalizeTaskOutputText(
            actionOutput.message,
            "Task failed"
          );
          output = taskState.error;
        }

        const step: AgentStep = {
          idx: currStep,
          agentOutput,
          actionOutput,
        };
        taskState.steps.push(step);
        await params?.onStep?.(step);
        currStep = currStep + 1;
        break;
      }

      if (actionOutput.success && actionType !== "wait") {
        const progressFingerprint = safeJsonStringify(
          {
            actionType,
            params: actionParams,
            url: safeGetPageUrl(page),
            domSignature: buildDomProgressSignature(domState),
          },
          0
        );
        if (progressFingerprint === lastSuccessfulProgressFingerprint) {
          consecutiveRepeatedSuccessfulActions++;
        } else {
          consecutiveRepeatedSuccessfulActions = 1;
          lastSuccessfulProgressFingerprint = progressFingerprint;
        }

        if (
          consecutiveRepeatedSuccessfulActions >=
          MAX_REPEATED_ACTIONS_WITHOUT_PROGRESS
        ) {
          taskState.status = TaskStatus.FAILED;
          taskState.error = normalizeTaskOutputText(
            `Agent appears stuck: repeated the same successful action ${MAX_REPEATED_ACTIONS_WITHOUT_PROGRESS} times without visible progress.`,
            "Agent appears stuck after repeated actions."
          );
          output = taskState.error;

          const step: AgentStep = {
            idx: currStep,
            agentOutput,
            actionOutput,
          };
          taskState.steps.push(step);
          await params?.onStep?.(step);
          break;
        }
      } else {
        consecutiveRepeatedSuccessfulActions = 0;
        lastSuccessfulProgressFingerprint = null;
      }

      // Check action result and handle retry logic
      if (actionType === "wait") {
        // Wait action - increment counter
        consecutiveFailuresOrWaits++;

        if (consecutiveFailuresOrWaits >= MAX_CONSECUTIVE_FAILURES_OR_WAITS) {
          taskState.status = TaskStatus.FAILED;
          taskState.error = normalizeTaskOutputText(
            `Agent is stuck: waited or failed ${MAX_CONSECUTIVE_FAILURES_OR_WAITS} consecutive times without making progress.`,
            "Agent is stuck after repeated waits."
          );
          output = taskState.error;

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
          taskState.error = normalizeTaskOutputText(
            `Agent is stuck: waited or failed ${MAX_CONSECUTIVE_FAILURES_OR_WAITS} consecutive times without making progress. Last error: ${actionOutput.message}`,
            "Agent is stuck after repeated failures."
          );
          output = taskState.error;

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
      const waitStats = normalizeWaitStats(await waitForSettledDOM(page));
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

      if (stepDebugArtifactsEnabled) {
        await writeFrameGraphSnapshot(page, debugStepDir, ctx.debug);
        writeDebugFileSafe(
          `${debugStepDir}/stepOutput.json`,
          safeJsonStringify(step),
          ctx.debug
        );
        writeDebugFileSafe(
          `${debugStepDir}/perf.json`,
          safeJsonStringify(stepMetrics),
          ctx.debug
        );
      }
    }

    logPerf(ctx.debug, `[Perf][runAgentTask] Task ${taskId}`, taskStart);
  } finally {
    cleanupDomListeners(page);
  }

  const actionCache: ActionCacheOutput = {
    taskId,
    createdAt: new Date().toISOString(),
    status: taskState.status,
    steps: actionCacheSteps,
  };
  if (debugArtifactsEnabled) {
    ensureDirectorySafe(debugDir, ctx.debug);
    writeDebugFileSafe(
      `${debugDir}/action-cache.json`,
      safeJsonStringify(actionCache),
      ctx.debug
    );
  }

  const taskOutput: AgentTaskOutput = {
    taskId,
    status: taskState.status,
    steps: taskState.steps,
    output,
    actionCache,
  };
  if (debugArtifactsEnabled) {
    writeDebugFileSafe(
      `${debugDir}/taskOutput.json`,
      safeJsonStringify(taskOutput),
      ctx.debug
    );
  }
  await params?.onComplete?.(taskOutput);
  return taskOutput;
};
