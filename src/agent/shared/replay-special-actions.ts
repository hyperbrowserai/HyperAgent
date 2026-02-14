import type { Page } from "playwright-core";
import { formatUnknownError } from "@/utils";
import { waitForSettledDOM } from "@/utils/waitForSettledDOM";
import { markDomSnapshotDirty } from "@/context-providers/a11y-dom/dom-cache";
import { TaskOutput, TaskStatus } from "@/types/agent/types";

interface ReplaySpecialActionInput {
  taskId: string;
  actionType: string;
  instruction?: string;
  arguments?: Array<string | number>;
  actionParams?: Record<string, unknown>;
  page: Page;
  retries?: number;
  filterAdTrackingFrames?: boolean;
}

const MAX_REPLAY_WAIT_MS = 120_000;
const MAX_REPLAY_TIMEOUT_MS = 120_000;
const MAX_REPLAY_SPECIAL_OUTPUT_CHARS = 4_000;
const MAX_REPLAY_SPECIAL_DIAGNOSTIC_CHARS = 400;
const MAX_REPLAY_SPECIAL_IDENTIFIER_CHARS = 128;

export const REPLAY_SPECIAL_ACTION_TYPES: ReadonlySet<string> = new Set([
  "goToUrl",
  "complete",
  "refreshPage",
  "wait",
  "waitForLoadState",
  "extract",
  "analyzePdf",
]);

function createReplayMeta(
  retries: number
): NonNullable<TaskOutput["replayStepMeta"]> {
  return {
    usedCachedAction: true,
    fallbackUsed: false,
    retries,
    cachedXPath: null,
    fallbackXPath: null,
    fallbackElementId: null,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNonEmptyTrimmedString(value: unknown): string | undefined {
  const parsed = asString(value)?.trim();
  return parsed && parsed.length > 0 ? parsed : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function sanitizeReplaySpecialText(value: string): string {
  if (value.length === 0) {
    return value;
  }
  const withoutControlChars = Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code < 32) || code === 127 ? " " : char;
  }).join("");
  return withoutControlChars.replace(/\s+/g, " ").trim();
}

function truncateReplaySpecialText(
  value: string,
  maxChars: number
): string {
  if (value.length <= maxChars) {
    return value;
  }
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}... [truncated ${omitted} chars]`;
}

function formatReplaySpecialDiagnostic(value: unknown): string {
  const normalized = sanitizeReplaySpecialText(formatUnknownError(value));
  const fallback = normalized.length > 0 ? normalized : "unknown error";
  return truncateReplaySpecialText(
    fallback,
    MAX_REPLAY_SPECIAL_DIAGNOSTIC_CHARS
  );
}

function normalizeReplaySpecialOutput(
  value: unknown,
  fallback: string
): string {
  if (typeof value !== "string") {
    return fallback;
  }
  if (value.length === 0) {
    return value;
  }
  const normalized = sanitizeReplaySpecialText(value);
  if (normalized.length === 0) {
    return fallback;
  }
  return truncateReplaySpecialText(normalized, MAX_REPLAY_SPECIAL_OUTPUT_CHARS);
}

function normalizeReplaySpecialIdentifier(
  value: unknown,
  fallback: string
): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = sanitizeReplaySpecialText(value);
  if (normalized.length === 0) {
    return fallback;
  }
  return truncateReplaySpecialText(
    normalized,
    MAX_REPLAY_SPECIAL_IDENTIFIER_CHARS
  );
}

function safeReadArrayIndex(
  value: unknown,
  index: number
): unknown {
  if (!Array.isArray(value)) {
    return undefined;
  }
  try {
    return value[index];
  } catch {
    return undefined;
  }
}

function safeReadRecordField(
  value: unknown,
  key: string
): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function normalizeRetryCount(value: unknown): number {
  const parsed = asNumber(value);
  if (parsed === undefined || parsed <= 0) {
    return 1;
  }
  return Math.floor(parsed);
}

function normalizeWaitMs(value: unknown): number {
  const parsed = asNumber(value);
  if (parsed === undefined) {
    return 1000;
  }
  if (parsed < 0) {
    return 1000;
  }
  return Math.min(parsed, MAX_REPLAY_WAIT_MS);
}

function normalizeOptionalTimeoutMs(value: unknown): number | undefined {
  const parsed = asNumber(value);
  if (parsed === undefined) {
    return undefined;
  }
  if (parsed < 0) {
    return undefined;
  }
  return Math.min(parsed, MAX_REPLAY_TIMEOUT_MS);
}

function normalizeWaitUntil(value: unknown): "domcontentloaded" | "load" | "networkidle" {
  const parsed = asNonEmptyTrimmedString(value)?.toLowerCase();
  if (parsed === "load" || parsed === "networkidle") {
    return parsed;
  }
  return "domcontentloaded";
}

function serializeUnknown(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("serialization produced undefined");
  }
  return serialized;
}

export async function executeReplaySpecialAction(
  params: ReplaySpecialActionInput
): Promise<TaskOutput | null> {
  let taskId: unknown;
  let actionType: unknown;
  let actionArgs: unknown;
  let actionParams: unknown;
  let instruction: unknown;
  let page: unknown;
  let retries: unknown;
  let filterAdTrackingFrames: unknown;
  try {
    taskId = params.taskId;
    actionType = params.actionType;
    actionArgs = params.arguments;
    actionParams = params.actionParams;
    instruction = params.instruction;
    page = params.page;
    retries = params.retries;
    filterAdTrackingFrames = params.filterAdTrackingFrames;
  } catch (error) {
    return {
      taskId: "unknown-replay-task",
      status: TaskStatus.FAILED,
      steps: [],
      output: `Invalid replay input: ${formatReplaySpecialDiagnostic(error)}`,
      replayStepMeta: createReplayMeta(1),
    };
  }

  const normalizedTaskId = normalizeReplaySpecialIdentifier(
    taskId,
    "unknown-replay-task"
  );
  const normalizedActionType = asNonEmptyTrimmedString(actionType);
  const normalizedRetries = normalizeRetryCount(retries);
  const normalizedInstruction = asString(instruction);
  const replayPage = page as Page;
  const normalizedFilterAdTrackingFrames =
    typeof filterAdTrackingFrames === "boolean"
      ? filterAdTrackingFrames
      : undefined;

  if (!normalizedActionType) {
    return null;
  }

  if (normalizedActionType === "goToUrl") {
    const url =
      asNonEmptyTrimmedString(safeReadArrayIndex(actionArgs, 0)) ??
      asNonEmptyTrimmedString(safeReadRecordField(actionParams, "url")) ??
      "";
    if (!url) {
      return {
        taskId: normalizedTaskId,
        status: TaskStatus.FAILED,
        steps: [],
        output: "Missing URL for goToUrl",
        replayStepMeta: createReplayMeta(normalizedRetries),
      };
    }
    await replayPage.goto(url, { waitUntil: "domcontentloaded" });
    await waitForSettledDOM(replayPage, undefined, {
      filterAdTrackingFrames: normalizedFilterAdTrackingFrames,
    });
    markDomSnapshotDirty(replayPage);
    return {
      taskId: normalizedTaskId,
      status: TaskStatus.COMPLETED,
      steps: [],
      output: `Navigated to ${normalizeReplaySpecialOutput(url, "about:blank")}`,
      replayStepMeta: createReplayMeta(normalizedRetries),
    };
  }

  if (normalizedActionType === "complete") {
    return {
      taskId: normalizedTaskId,
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "Task Complete",
      replayStepMeta: createReplayMeta(normalizedRetries),
    };
  }

  if (normalizedActionType === "refreshPage") {
    await replayPage.reload({ waitUntil: "domcontentloaded" });
    await waitForSettledDOM(replayPage, undefined, {
      filterAdTrackingFrames: normalizedFilterAdTrackingFrames,
    });
    markDomSnapshotDirty(replayPage);
    return {
      taskId: normalizedTaskId,
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "Page refreshed",
      replayStepMeta: createReplayMeta(normalizedRetries),
    };
  }

  if (normalizedActionType === "wait") {
    const waitMs = normalizeWaitMs(
      safeReadArrayIndex(actionArgs, 0) ?? safeReadRecordField(actionParams, "duration")
    );
    await replayPage.waitForTimeout(waitMs);
    markDomSnapshotDirty(replayPage);
    return {
      taskId: normalizedTaskId,
      status: TaskStatus.COMPLETED,
      steps: [],
      output: `Waited ${waitMs}ms`,
      replayStepMeta: createReplayMeta(normalizedRetries),
    };
  }

  if (normalizedActionType === "extract") {
    const extractPage = replayPage as Page & {
      extract?: (objective: string) => Promise<string | unknown>;
    };
    const extractInstruction = normalizedInstruction?.trim();
    if (!extractInstruction) {
      return {
        taskId: normalizedTaskId,
        status: TaskStatus.FAILED,
        steps: [],
        output: "Missing objective/instruction for extract action",
        replayStepMeta: createReplayMeta(normalizedRetries),
      };
    }
    if (!extractPage.extract) {
      return {
        taskId: normalizedTaskId,
        status: TaskStatus.FAILED,
        steps: [],
        output: "Extract replay is unavailable on this page instance.",
        replayStepMeta: createReplayMeta(normalizedRetries),
      };
    }
    try {
      const extracted = await extractPage.extract(extractInstruction);
      let serializedExtracted = "";
      if (typeof extracted === "string") {
        serializedExtracted = extracted;
      } else {
        try {
          serializedExtracted = serializeUnknown(extracted);
        } catch (error) {
          const message = formatReplaySpecialDiagnostic(error);
          return {
            taskId: normalizedTaskId,
            status: TaskStatus.FAILED,
            steps: [],
            output: `Extract failed: could not serialize extracted output (${message})`,
            replayStepMeta: createReplayMeta(normalizedRetries),
          };
        }
      }
      return {
        taskId: normalizedTaskId,
        status: TaskStatus.COMPLETED,
        steps: [],
        output: normalizeReplaySpecialOutput(
          serializedExtracted,
          "Extract completed."
        ),
        replayStepMeta: createReplayMeta(normalizedRetries),
      };
    } catch (error) {
      const message = formatReplaySpecialDiagnostic(error);
      return {
        taskId: normalizedTaskId,
        status: TaskStatus.FAILED,
        steps: [],
        output: `Extract failed: ${message}`,
        replayStepMeta: createReplayMeta(normalizedRetries),
      };
    }
  }

  if (normalizedActionType === "analyzePdf") {
    return {
      taskId: normalizedTaskId,
      status: TaskStatus.FAILED,
      steps: [],
      output: "analyzePdf replay is not supported in runFromActionCache.",
      replayStepMeta: createReplayMeta(normalizedRetries),
    };
  }

  if (normalizedActionType === "waitForLoadState") {
    const waitUntil = normalizeWaitUntil(
      safeReadArrayIndex(actionArgs, 0) ?? safeReadRecordField(actionParams, "waitUntil")
    );
    const timeoutMs = normalizeOptionalTimeoutMs(
      safeReadArrayIndex(actionArgs, 1) ?? safeReadRecordField(actionParams, "timeout")
    );
    const options =
      timeoutMs !== undefined ? { timeout: timeoutMs } : undefined;
    await replayPage.waitForLoadState(
      waitUntil,
      options
    );
    await waitForSettledDOM(replayPage, undefined, {
      filterAdTrackingFrames: normalizedFilterAdTrackingFrames,
    }).catch(() => undefined);
    markDomSnapshotDirty(replayPage);
    return {
      taskId: normalizedTaskId,
      status: TaskStatus.COMPLETED,
      steps: [],
      output: `Waited for load state: ${waitUntil}`,
      replayStepMeta: createReplayMeta(normalizedRetries),
    };
  }

  return null;
}
