import { HyperPage, TaskOutput } from "@/types/agent/types";
import { waitForSettledDOM } from "@/utils/waitForSettledDOM";
import { markDomSnapshotDirty } from "@/context-providers/a11y-dom/dom-cache";

const DEFAULT_MAX_STEPS = 3;

type PageAction =
  | "click"
  | "fill"
  | "type"
  | "press"
  | "selectOptionFromDropdown"
  | "check"
  | "uncheck"
  | "hover"
  | "scrollToElement"
  | "scrollToPercentage"
  | "nextChunk"
  | "prevChunk";

interface PerformOptions {
  frameIndex?: number | null;
  performInstruction?: string | null;
  maxSteps?: number;
}

interface PerformValueOptions extends PerformOptions {
  value: string;
}

interface PerformPositionOptions extends PerformOptions {
  position: string | number;
}

export async function performGoTo(
  page: HyperPage,
  url: string,
  waitUntil: "domcontentloaded" | "load" | "networkidle" = "domcontentloaded"
): Promise<void> {
  await page.goto(url, { waitUntil });
  await waitForSettledDOM(page);
  markDomSnapshotDirty(page);
}

function runCachedAction(
  page: HyperPage,
  instruction: string,
  method: PageAction,
  xpath: string,
  args: unknown[],
  options?: PerformOptions
): Promise<TaskOutput> {
  return page.perform(instruction, {
    cachedAction: {
      actionType: "actElement",
      method,
      arguments: args as string[],
      frameIndex: options?.frameIndex ?? 0,
      xpath,
    },
    maxSteps: options?.maxSteps ?? DEFAULT_MAX_STEPS,
  });
}

export function attachCachedActionHelpers(page: HyperPage): void {
  page.performClick = (
    xpath: string,
    options?: PerformOptions
  ) =>
    runCachedAction(
      page,
      options?.performInstruction || "Click element",
      "click",
      xpath,
      [],
      options
    );

  page.performHover = (
    xpath: string,
    options?: PerformOptions
  ) =>
    runCachedAction(
      page,
      options?.performInstruction || "Hover element",
      "hover",
      xpath,
      [],
      options
    );

  page.performType = (
    xpath: string,
    text: string,
    options?: PerformOptions
  ) =>
    runCachedAction(
      page,
      options?.performInstruction || "Type text",
      "type",
      xpath,
      [text],
      options
    );

  page.performFill = (
    xpath: string,
    text: string,
    options?: PerformOptions
  ) =>
    runCachedAction(
      page,
      options?.performInstruction || "Fill input",
      "fill",
      xpath,
      [text],
      options
    );

  page.performPress = (
    xpath: string,
    key: string,
    options?: PerformOptions
  ) =>
    runCachedAction(
      page,
      options?.performInstruction || "Press key",
      "press",
      xpath,
      [key],
      options
    );

  page.performSelectOption = (
    xpath: string,
    option: string,
    options?: PerformOptions
  ) =>
    runCachedAction(
      page,
      options?.performInstruction || "Select option",
      "selectOptionFromDropdown",
      xpath,
      [option],
      options
    );

  page.performCheck = (
    xpath: string,
    options?: PerformOptions
  ) =>
    runCachedAction(
      page,
      options?.performInstruction || "Check element",
      "check",
      xpath,
      [],
      options
    );

  page.performUncheck = (
    xpath: string,
    options?: PerformOptions
  ) =>
    runCachedAction(
      page,
      options?.performInstruction || "Uncheck element",
      "uncheck",
      xpath,
      [],
      options
    );

  page.performScrollToElement = (
    xpath: string,
    options?: PerformOptions
  ) =>
    runCachedAction(
      page,
      options?.performInstruction || "Scroll to element",
      "scrollToElement",
      xpath,
      [],
      options
    );

  page.performScrollToPercentage = (
    xpath: string,
    position: string | number,
    options?: PerformOptions
  ) =>
    runCachedAction(
      page,
      options?.performInstruction || "Scroll to percentage",
      "scrollToPercentage",
      xpath,
      [position],
      options
    );

  page.performNextChunk = (
    xpath: string,
    options?: PerformOptions
  ) =>
    runCachedAction(
      page,
      options?.performInstruction || "Scroll next chunk",
      "nextChunk",
      xpath,
      [],
      options
    );

  page.performPrevChunk = (
    xpath: string,
    options?: PerformOptions
  ) =>
    runCachedAction(
      page,
      options?.performInstruction || "Scroll previous chunk",
      "prevChunk",
      xpath,
      [],
      options
    );
}

export { DEFAULT_MAX_STEPS };
