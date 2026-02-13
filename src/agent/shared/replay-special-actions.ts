import type { Page } from "playwright-core";
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
}

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

function normalizeWaitMs(value: unknown): number {
  const parsed = asNumber(value);
  if (parsed === undefined) {
    return 1000;
  }
  return parsed >= 0 ? parsed : 1000;
}

function normalizeOptionalTimeoutMs(value: unknown): number | undefined {
  const parsed = asNumber(value);
  if (parsed === undefined) {
    return undefined;
  }
  return parsed >= 0 ? parsed : undefined;
}

function normalizeWaitUntil(value: unknown): "domcontentloaded" | "load" | "networkidle" {
  const parsed = asNonEmptyTrimmedString(value)?.toLowerCase();
  if (parsed === "load" || parsed === "networkidle") {
    return parsed;
  }
  return "domcontentloaded";
}

function formatUnknownError(error: unknown): string {
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
  const {
    taskId,
    actionType,
    arguments: actionArgs,
    actionParams,
    instruction,
    page,
    retries = 1,
  } = params;

  if (actionType === "goToUrl") {
    const url =
      asNonEmptyTrimmedString(actionArgs?.[0]) ??
      asNonEmptyTrimmedString(actionParams?.url) ??
      "";
    if (!url) {
      return {
        taskId,
        status: TaskStatus.FAILED,
        steps: [],
        output: "Missing URL for goToUrl",
        replayStepMeta: createReplayMeta(retries),
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
      replayStepMeta: createReplayMeta(retries),
    };
  }

  if (actionType === "complete") {
    return {
      taskId,
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "Task Complete",
      replayStepMeta: createReplayMeta(retries),
    };
  }

  if (actionType === "refreshPage") {
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForSettledDOM(page);
    markDomSnapshotDirty(page);
    return {
      taskId,
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "Page refreshed",
      replayStepMeta: createReplayMeta(retries),
    };
  }

  if (actionType === "wait") {
    const waitMs = normalizeWaitMs(actionArgs?.[0] ?? actionParams?.duration);
    await page.waitForTimeout(waitMs);
    markDomSnapshotDirty(page);
    return {
      taskId,
      status: TaskStatus.COMPLETED,
      steps: [],
      output: `Waited ${waitMs}ms`,
      replayStepMeta: createReplayMeta(retries),
    };
  }

  if (actionType === "extract") {
    const extractPage = page as Page & {
      extract?: (objective: string) => Promise<string | unknown>;
    };
    const extractInstruction = instruction?.trim();
    if (!extractInstruction) {
      return {
        taskId,
        status: TaskStatus.FAILED,
        steps: [],
        output: "Missing objective/instruction for extract action",
        replayStepMeta: createReplayMeta(retries),
      };
    }
    if (!extractPage.extract) {
      return {
        taskId,
        status: TaskStatus.FAILED,
        steps: [],
        output: "Extract replay is unavailable on this page instance.",
        replayStepMeta: createReplayMeta(retries),
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
          const message = formatUnknownError(error);
          return {
            taskId,
            status: TaskStatus.FAILED,
            steps: [],
            output: `Extract failed: could not serialize extracted output (${message})`,
            replayStepMeta: createReplayMeta(retries),
          };
        }
      }
      return {
        taskId,
        status: TaskStatus.COMPLETED,
        steps: [],
        output: serializedExtracted,
        replayStepMeta: createReplayMeta(retries),
      };
    } catch (error) {
      const message = formatUnknownError(error);
      return {
        taskId,
        status: TaskStatus.FAILED,
        steps: [],
        output: `Extract failed: ${message}`,
        replayStepMeta: createReplayMeta(retries),
      };
    }
  }

  if (actionType === "analyzePdf") {
    return {
      taskId,
      status: TaskStatus.FAILED,
      steps: [],
      output: "analyzePdf replay is not supported in runFromActionCache.",
      replayStepMeta: createReplayMeta(retries),
    };
  }

  if (actionType === "waitForLoadState") {
    const waitUntil = normalizeWaitUntil(actionArgs?.[0] ?? actionParams?.waitUntil);
    const timeoutMs = normalizeOptionalTimeoutMs(
      actionArgs?.[1] ?? actionParams?.timeout
    );
    const options =
      timeoutMs !== undefined ? { timeout: timeoutMs } : undefined;
    await page.waitForLoadState(
      waitUntil,
      options
    );
    await waitForSettledDOM(page);
    markDomSnapshotDirty(page);
    return {
      taskId,
      status: TaskStatus.COMPLETED,
      steps: [],
      output: `Waited for load state: ${waitUntil}`,
      replayStepMeta: createReplayMeta(retries),
    };
  }

  return null;
}
