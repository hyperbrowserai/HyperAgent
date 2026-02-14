import {
  AgentDeps,
  HyperPage,
  PerformOptions,
  TaskOutput,
} from "@/types/agent/types";
import * as cachedRunner from "./run-cached-action";
import { formatUnknownError } from "@/utils";

const DEFAULT_MAX_STEPS = 3;
const MAX_PERFORM_MAX_STEPS = 20;
const MAX_PERFORM_FRAME_INDEX = 1_000;
const MAX_PERFORM_VALUE_CHARS = 20_000;
const MAX_PERFORM_HELPER_DIAGNOSTIC_CHARS = 400;

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

const pageActionMethodSet: ReadonlySet<string> = new Set(PAGE_ACTION_METHODS);
const pageActionMethodMap: ReadonlyMap<string, PageAction> = new Map(
  PAGE_ACTION_METHODS.map((method) => [method.toLowerCase(), method])
);

export type PageAction = (typeof PAGE_ACTION_METHODS)[number];

export function normalizePageActionMethod(
  method: string | null | undefined
): PageAction | null {
  const normalizedMethod = method?.trim().toLowerCase();
  if (!normalizedMethod) {
    return null;
  }
  return pageActionMethodMap.get(normalizedMethod) ?? null;
}

export function isPageActionMethod(method: string): method is PageAction {
  return pageActionMethodSet.has(method);
}

export function dispatchPerformHelper(
  hp: HyperPage,
  method: PageAction,
  xpath: string,
  value: string | undefined,
  options: PerformOptions
): Promise<TaskOutput> {
  const formatPerformHelperDiagnostic = (error: unknown): string => {
    const normalized = Array.from(formatUnknownError(error), (char) => {
      const code = char.charCodeAt(0);
      return (code >= 0 && code < 32) || code === 127 ? " " : char;
    })
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    const fallback = normalized.length > 0 ? normalized : "unknown error";
    if (fallback.length <= MAX_PERFORM_HELPER_DIAGNOSTIC_CHARS) {
      return fallback;
    }
    const omitted = fallback.length - MAX_PERFORM_HELPER_DIAGNOSTIC_CHARS;
    return `${fallback.slice(
      0,
      MAX_PERFORM_HELPER_DIAGNOSTIC_CHARS
    )}... [truncated ${omitted} chars]`;
  };

  const invoke = (
    helperName: string,
    helperArgs: unknown[]
  ): Promise<TaskOutput> => {
    let helper: unknown;
    try {
      helper = (hp as unknown as Record<string, unknown>)[helperName];
    } catch (error) {
      return Promise.reject(
        new Error(
          `[Replay] Failed to access ${helperName}: ${formatPerformHelperDiagnostic(
            error
          )}`
        )
      );
    }
    if (typeof helper !== "function") {
      return Promise.reject(new Error(`[Replay] Missing perform helper: ${helperName}`));
    }
    try {
      return helper(...helperArgs) as Promise<TaskOutput>;
    } catch (error) {
      return Promise.reject(
        new Error(
          `[Replay] ${helperName} failed before execution: ${formatPerformHelperDiagnostic(
            error
          )}`
        )
      );
    }
  };

  switch (method) {
    case "click":
      return invoke("performClick", [xpath, options]);
    case "hover":
      return invoke("performHover", [xpath, options]);
    case "type":
      return invoke("performType", [xpath, value ?? "", options]);
    case "fill":
      return invoke("performFill", [xpath, value ?? "", options]);
    case "press":
      return invoke("performPress", [xpath, value ?? "", options]);
    case "selectOptionFromDropdown":
      return invoke("performSelectOption", [xpath, value ?? "", options]);
    case "check":
      return invoke("performCheck", [xpath, options]);
    case "uncheck":
      return invoke("performUncheck", [xpath, options]);
    case "scrollToElement":
      return invoke("performScrollToElement", [xpath, options]);
    case "scrollToPercentage":
      return invoke("performScrollToPercentage", [xpath, value ?? "", options]);
    case "nextChunk":
      return invoke("performNextChunk", [xpath, options]);
    case "prevChunk":
      return invoke("performPrevChunk", [xpath, options]);
    default:
      throw new Error(`Unknown perform helper method: ${method}`);
  }
}

function safeReadOptionField(
  options: PerformOptions | undefined,
  key: keyof PerformOptions
): unknown {
  if (!options || typeof options !== "object") {
    return undefined;
  }
  try {
    return (options as unknown as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function normalizeInstruction(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code < 32) || code === 127 ? " " : char;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeOptionalTextArg(value: string | number): string | number {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code < 32) || code === 127 ? " " : char;
  }).join("");
  if (normalized.length <= MAX_PERFORM_VALUE_CHARS) {
    return normalized;
  }
  return normalized.slice(0, MAX_PERFORM_VALUE_CHARS);
}

function normalizeMaxSteps(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_STEPS;
  }
  return Math.min(Math.floor(value), MAX_PERFORM_MAX_STEPS);
}

function normalizeFrameIndex(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (value < 0) {
    return null;
  }
  return Math.min(Math.floor(value), MAX_PERFORM_FRAME_INDEX);
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
  const normalizedDefaultInstruction = normalizeInstruction(
    instruction,
    "Execute cached action"
  );
  const normalizedPerformInstruction = normalizeInstruction(
    safeReadOptionField(options, "performInstruction"),
    ""
  );
  const runInstruction =
    normalizedPerformInstruction.length > 0
      ? normalizedPerformInstruction
      : normalizedDefaultInstruction;
  const normalizedXPath = normalizeInstruction(xpath, "//");
  const normalizedArgs = args.map(normalizeOptionalTextArg);
  const normalizedFrameIndex = normalizeFrameIndex(
    safeReadOptionField(options, "frameIndex")
  );
  const normalizedMaxSteps = normalizeMaxSteps(
    safeReadOptionField(options, "maxSteps")
  );
  const cachedAction = {
    actionType: "actElement",
    method,
    arguments: normalizedArgs,
    frameIndex: normalizedFrameIndex ?? 0,
    xpath: normalizedXPath,
  };

  return cachedRunner.runCachedStep({
    page,
    instruction: runInstruction,
    cachedAction,
    maxSteps: normalizedMaxSteps,
    debug: agent.debug,
    tokenLimit: agent.tokenLimit,
    llm: agent.llm,
    mcpClient: agent.mcpClient,
    variables: agent.variables ?? [],
    preferScriptBoundingBox: agent.debug,
    cdpActionsEnabled: agent.cdpActionsEnabled,
    performFallback: normalizedPerformInstruction
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
      "Click element",
      "click",
      xpath,
      [],
      options
    );

  page.performHover = (xpath: string, options?: PerformOptions) =>
    runCachedAction(
      agent,
      page,
      "Hover element",
      "hover",
      xpath,
      [],
      options
    );

  page.performType = (xpath: string, text: string, options?: PerformOptions) =>
    runCachedAction(
      agent,
      page,
      "Type text",
      "type",
      xpath,
      [text],
      options
    );

  page.performFill = (xpath: string, text: string, options?: PerformOptions) =>
    runCachedAction(
      agent,
      page,
      "Fill input",
      "fill",
      xpath,
      [text],
      options
    );

  page.performPress = (xpath: string, key: string, options?: PerformOptions) =>
    runCachedAction(
      agent,
      page,
      "Press key",
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
      "Select option",
      "selectOptionFromDropdown",
      xpath,
      [option],
      options
    );

  page.performCheck = (xpath: string, options?: PerformOptions) =>
    runCachedAction(
      agent,
      page,
      "Check element",
      "check",
      xpath,
      [],
      options
    );

  page.performUncheck = (xpath: string, options?: PerformOptions) =>
    runCachedAction(
      agent,
      page,
      "Uncheck element",
      "uncheck",
      xpath,
      [],
      options
    );

  page.performScrollToElement = (xpath: string, options?: PerformOptions) =>
    runCachedAction(
      agent,
      page,
      "Scroll to element",
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
      "Scroll to percentage",
      "scrollToPercentage",
      xpath,
      [position],
      options
    );

  page.performNextChunk = (xpath: string, options?: PerformOptions) =>
    runCachedAction(
      agent,
      page,
      "Scroll next chunk",
      "nextChunk",
      xpath,
      [],
      options
    );

  page.performPrevChunk = (xpath: string, options?: PerformOptions) =>
    runCachedAction(
      agent,
      page,
      "Scroll previous chunk",
      "prevChunk",
      xpath,
      [],
      options
    );
}

export { DEFAULT_MAX_STEPS };
