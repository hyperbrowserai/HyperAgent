import {
  AgentDeps,
  HyperPage,
  PerformOptions,
  TaskOutput,
} from "@/types/agent/types";
import * as cachedRunner from "./run-cached-action";

const DEFAULT_MAX_STEPS = 3;

export const PAGE_ACTION_METHODS = [
  "click",
  "fill",
  "type",
  "press",
  "selectOptionFromDropdown",
  "check",
  "uncheck",
  "hover",
  "scrollToElement",
  "scrollToPercentage",
  "nextChunk",
  "prevChunk",
] as const;

type Includes<T extends readonly string[]> = (
  haystack: readonly string[],
  needle: string
) => needle is T[number];

const includes = ((haystack: readonly string[], needle: string): boolean =>
  haystack.includes(needle)) as Includes<typeof PAGE_ACTION_METHODS>;

export type PageAction = (typeof PAGE_ACTION_METHODS)[number];

export function isPageActionMethod(method: string): method is PageAction {
  return includes(PAGE_ACTION_METHODS, method);
}

export function dispatchPerformHelper(
  hp: HyperPage,
  method: PageAction,
  xpath: string,
  value: string | undefined,
  options: PerformOptions
): Promise<TaskOutput> {
  switch (method) {
    case "click":
      return hp.performClick(xpath, options);
    case "hover":
      return hp.performHover(xpath, options);
    case "type":
      return hp.performType(xpath, value ?? "", options);
    case "fill":
      return hp.performFill(xpath, value ?? "", options);
    case "press":
      return hp.performPress(xpath, value ?? "", options);
    case "selectOptionFromDropdown":
      return hp.performSelectOption(xpath, value ?? "", options);
    case "check":
      return hp.performCheck(xpath, options);
    case "uncheck":
      return hp.performUncheck(xpath, options);
    case "scrollToElement":
      return hp.performScrollToElement(xpath, options);
    case "scrollToPercentage":
      return hp.performScrollToPercentage(xpath, value ?? "", options);
    case "nextChunk":
      return hp.performNextChunk(xpath, options);
    case "prevChunk":
      return hp.performPrevChunk(xpath, options);
    default:
      throw new Error(`Unknown perform helper method: ${method}`);
  }
}

function runCachedAction(
  agent: AgentDeps,
  page: HyperPage,
  instruction: string,
  method: PageAction,
  xpath: string,
  args: Array<string | number>,
  options?: PerformOptions
): Promise<TaskOutput> {
  const runInstruction =
    options?.performInstruction && options.performInstruction.length > 0
      ? options.performInstruction
      : instruction;
  const cachedAction = {
    actionType: "actElement",
    method,
    arguments: args,
    frameIndex: options?.frameIndex ?? 0,
    xpath,
  };

  return cachedRunner.runCachedStep({
    page,
    instruction: runInstruction,
    cachedAction,
    maxSteps: options?.maxSteps ?? DEFAULT_MAX_STEPS,
    debug: agent.debug,
    tokenLimit: agent.tokenLimit,
    llm: agent.llm,
    mcpClient: agent.mcpClient,
    variables: agent.variables ?? [],
    preferScriptBoundingBox: agent.debug,
    cdpActionsEnabled: agent.cdpActionsEnabled,
    performFallback: options?.performInstruction
      ? (instr) => page.perform(instr)
      : undefined,
  });
}

export function attachCachedActionHelpers(
  agent: AgentDeps,
  page: HyperPage
): void {
  page.performClick = (xpath: string, options?: PerformOptions) =>
    runCachedAction(
      agent,
      page,
      options?.performInstruction || "Click element",
      "click",
      xpath,
      [],
      options
    );

  page.performHover = (xpath: string, options?: PerformOptions) =>
    runCachedAction(
      agent,
      page,
      options?.performInstruction || "Hover element",
      "hover",
      xpath,
      [],
      options
    );

  page.performType = (xpath: string, text: string, options?: PerformOptions) =>
    runCachedAction(
      agent,
      page,
      options?.performInstruction || "Type text",
      "type",
      xpath,
      [text],
      options
    );

  page.performFill = (xpath: string, text: string, options?: PerformOptions) =>
    runCachedAction(
      agent,
      page,
      options?.performInstruction || "Fill input",
      "fill",
      xpath,
      [text],
      options
    );

  page.performPress = (xpath: string, key: string, options?: PerformOptions) =>
    runCachedAction(
      agent,
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
      agent,
      page,
      options?.performInstruction || "Select option",
      "selectOptionFromDropdown",
      xpath,
      [option],
      options
    );

  page.performCheck = (xpath: string, options?: PerformOptions) =>
    runCachedAction(
      agent,
      page,
      options?.performInstruction || "Check element",
      "check",
      xpath,
      [],
      options
    );

  page.performUncheck = (xpath: string, options?: PerformOptions) =>
    runCachedAction(
      agent,
      page,
      options?.performInstruction || "Uncheck element",
      "uncheck",
      xpath,
      [],
      options
    );

  page.performScrollToElement = (xpath: string, options?: PerformOptions) =>
    runCachedAction(
      agent,
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
      agent,
      page,
      options?.performInstruction || "Scroll to percentage",
      "scrollToPercentage",
      xpath,
      [position],
      options
    );

  page.performNextChunk = (xpath: string, options?: PerformOptions) =>
    runCachedAction(
      agent,
      page,
      options?.performInstruction || "Scroll next chunk",
      "nextChunk",
      xpath,
      [],
      options
    );

  page.performPrevChunk = (xpath: string, options?: PerformOptions) =>
    runCachedAction(
      agent,
      page,
      options?.performInstruction || "Scroll previous chunk",
      "prevChunk",
      xpath,
      [],
      options
    );
}

export { DEFAULT_MAX_STEPS };
