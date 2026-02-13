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
}

function createReplayMeta(): NonNullable<TaskOutput["replayStepMeta"]> {
  return {
    usedCachedAction: true,
    fallbackUsed: false,
    retries: 0,
    cachedXPath: null,
    fallbackXPath: null,
    fallbackElementId: null,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
  } = params;

  if (actionType === "goToUrl") {
    const url =
      asString(actionArgs?.[0]) ??
      asString(actionParams?.url) ??
      "";
    if (!url) {
      return {
        taskId,
        status: TaskStatus.FAILED,
        steps: [],
        output: "Missing URL for goToUrl",
        replayStepMeta: createReplayMeta(),
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
      replayStepMeta: createReplayMeta(),
    };
  }

  if (actionType === "complete") {
    return {
      taskId,
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "Task Complete",
      replayStepMeta: createReplayMeta(),
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
      replayStepMeta: createReplayMeta(),
    };
  }

  if (actionType === "wait") {
    const waitMs = asNumber(actionArgs?.[0] ?? actionParams?.duration) ?? 1000;
    await page.waitForTimeout(waitMs);
    return {
      taskId,
      status: TaskStatus.COMPLETED,
      steps: [],
      output: `Waited ${waitMs}ms`,
      replayStepMeta: createReplayMeta(),
    };
  }

  if (actionType === "extract") {
    const extractPage = page as Page & {
      extract?: (objective: string) => Promise<string | unknown>;
    };
    if (!instruction) {
      return {
        taskId,
        status: TaskStatus.FAILED,
        steps: [],
        output: "Missing objective/instruction for extract action",
        replayStepMeta: createReplayMeta(),
      };
    }
    if (!extractPage.extract) {
      return {
        taskId,
        status: TaskStatus.FAILED,
        steps: [],
        output: "Extract replay is unavailable on this page instance.",
        replayStepMeta: createReplayMeta(),
      };
    }
    try {
      const extracted = await extractPage.extract(instruction);
      return {
        taskId,
        status: TaskStatus.COMPLETED,
        steps: [],
        output:
          typeof extracted === "string"
            ? extracted
            : JSON.stringify(extracted),
        replayStepMeta: createReplayMeta(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        taskId,
        status: TaskStatus.FAILED,
        steps: [],
        output: `Extract failed: ${message}`,
        replayStepMeta: createReplayMeta(),
      };
    }
  }

  if (actionType === "analyzePdf") {
    return {
      taskId,
      status: TaskStatus.FAILED,
      steps: [],
      output: "analyzePdf replay is not supported in runFromActionCache.",
      replayStepMeta: createReplayMeta(),
    };
  }

  return null;
}
