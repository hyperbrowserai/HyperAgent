import { AgentStep } from "@/types";
import { HyperAgentMessage } from "@/llm/types";
import { Page } from "playwright-core";
import { getScrollInfo } from "./utils";
import { retry } from "@/utils/retry";
import { A11yDOMState } from "@/context-providers/a11y-dom/types";
import { HyperVariable } from "@/types/agent/types";
import { formatUnknownError } from "@/utils";

const MAX_HISTORY_STEPS = 10;
const MAX_SERIALIZED_PROMPT_VALUE_CHARS = 2000;
const MAX_DOM_STATE_CHARS = 50_000;
const MAX_OPEN_TAB_ENTRIES = 20;
const MAX_TAB_URL_CHARS = 500;
const MAX_VARIABLE_KEY_CHARS = 120;
const MAX_OMITTED_STEP_SUMMARY_STEPS = 5;
const MAX_OMITTED_STEP_SUMMARY_CHARS = 1_500;
const MAX_OMITTED_STEP_ACTION_CHARS = 120;
const MAX_OMITTED_STEP_OUTCOME_CHARS = 220;

function truncatePromptText(value: string): string {
  if (value.length <= MAX_SERIALIZED_PROMPT_VALUE_CHARS) {
    return value;
  }
  return (
    value.slice(0, MAX_SERIALIZED_PROMPT_VALUE_CHARS) +
    "... [truncated for prompt budget]"
  );
}

function truncateTabUrl(url: string): string {
  const normalized = Array.from(url)
    .map((char) => {
      const code = char.charCodeAt(0);
      return (code >= 0 && code < 32) || code === 127 ? " " : char;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length === 0) {
    return "about:blank (url unavailable)";
  }

  if (normalized.length <= MAX_TAB_URL_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_TAB_URL_CHARS)}... [tab url truncated]`;
}

function truncateDomState(domState: string): string {
  if (domState.length <= MAX_DOM_STATE_CHARS) {
    return domState;
  }
  return (
    domState.slice(0, MAX_DOM_STATE_CHARS) +
    "... [DOM truncated for prompt budget]"
  );
}

function stripControlChars(value: string): string {
  return Array.from(value)
    .map((char) => {
      const code = char.charCodeAt(0);
      return (code >= 0 && code < 32) || code === 127 ? " " : char;
    })
    .join("");
}

function normalizeCompactStepText(
  value: unknown,
  fallback: string,
  maxChars: number
): string {
  const rawValue = typeof value === "string" ? value : formatUnknownError(value);
  const normalized = stripControlChars(rawValue).replace(/\s+/g, " ").trim();
  const safeValue = normalized.length > 0 ? normalized : fallback;
  if (safeValue.length <= maxChars) {
    return safeValue;
  }
  return `${safeValue.slice(0, maxChars)}... [truncated]`;
}

function truncateOmittedSummary(value: string): string {
  if (value.length <= MAX_OMITTED_STEP_SUMMARY_CHARS) {
    return value;
  }
  const omitted = value.length - MAX_OMITTED_STEP_SUMMARY_CHARS;
  return `${value.slice(0, MAX_OMITTED_STEP_SUMMARY_CHARS)}... [summary truncated ${omitted} chars]`;
}

function getStepIndexLabel(step: AgentStep, fallback: number): number {
  const idx = safeReadRecordField(step, "idx");
  if (typeof idx === "number" && Number.isFinite(idx) && idx >= 0) {
    return Math.floor(idx);
  }
  return fallback;
}

function buildOmittedStepsSummary(steps: AgentStep[]): string {
  if (steps.length === 0) {
    return "";
  }

  const summarizedSteps = steps.slice(-MAX_OMITTED_STEP_SUMMARY_STEPS);
  const omittedSummaryCount = steps.length - summarizedSteps.length;
  const lines = summarizedSteps.map((step, index) => {
    const { action, message } = getStepPromptData(step);
    const actionType = normalizeCompactStepText(
      safeReadRecordField(action, "type"),
      "unknown",
      MAX_OMITTED_STEP_ACTION_CHARS
    );
    const outcome = normalizeCompactStepText(
      message,
      "Action output unavailable",
      MAX_OMITTED_STEP_OUTCOME_CHARS
    );
    const stepIndex = getStepIndexLabel(step, index);
    return `- Step ${stepIndex}: action=${actionType}; outcome=${outcome}`;
  });

  const prefix =
    omittedSummaryCount > 0
      ? `(${omittedSummaryCount} earlier omitted step${omittedSummaryCount === 1 ? "" : "s"} not summarized)\n`
      : "";
  return truncatePromptText(truncateOmittedSummary(`${prefix}${lines.join("\n")}`));
}

function normalizeVariableKey(value: unknown, index: number): string {
  const rawValue = typeof value === "string" ? value : formatUnknownError(value);
  const normalized = stripControlChars(rawValue).replace(/\s+/g, " ").trim();
  const fallback = normalized.length > 0 ? normalized : `variable_${index + 1}`;
  if (fallback.length <= MAX_VARIABLE_KEY_CHARS) {
    return fallback;
  }
  return `${fallback.slice(0, MAX_VARIABLE_KEY_CHARS)}... [variable key truncated]`;
}

function normalizeVariableDescription(value: unknown): string {
  const rawValue = typeof value === "string" ? value : formatUnknownError(value);
  const normalized = stripControlChars(rawValue).replace(/\s+/g, " ").trim();
  return truncatePromptText(
    normalized.length > 0 ? normalized : "Variable description unavailable"
  );
}

function safeReadVariableField(
  variable: HyperVariable,
  field: "key" | "description" | "value"
): unknown {
  try {
    return (variable as unknown as Record<string, unknown>)[field];
  } catch {
    if (field === "value") {
      return "[variable value unavailable]";
    }
    if (field === "description") {
      return "Variable description unavailable";
    }
    return "";
  }
}

function safeReadRecordField(source: unknown, field: string): unknown {
  if (!source || typeof source !== "object") {
    return undefined;
  }
  try {
    return (source as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

function normalizeStepText(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    return truncatePromptText(value);
  }
  if (typeof value === "undefined") {
    return fallback;
  }
  return truncatePromptText(formatUnknownError(value));
}

function buildVariablesContent(variables: HyperVariable[]): string {
  if (variables.length === 0) {
    return "No variables set";
  }

  return variables
    .map((variable, index) => {
      const key = normalizeVariableKey(safeReadVariableField(variable, "key"), index);
      const description = normalizeVariableDescription(
        safeReadVariableField(variable, "description")
      );
      const currentValue = safeSerializeForPrompt(
        safeReadVariableField(variable, "value")
      );
      return `<<${key}>> - ${description} | current value: ${currentValue}`;
    })
    .join("\n");
}

function getStepPromptData(step: AgentStep): {
  thoughts: string;
  memory: string;
  action: unknown;
  message: string;
  extract: unknown;
  hasExtract: boolean;
} {
  const agentOutput = safeReadRecordField(step, "agentOutput");
  const actionOutput = safeReadRecordField(step, "actionOutput");

  const thoughts = normalizeStepText(
    safeReadRecordField(agentOutput, "thoughts"),
    "Thoughts unavailable"
  );
  const memory = normalizeStepText(
    safeReadRecordField(agentOutput, "memory"),
    "Memory unavailable"
  );
  const action = safeReadRecordField(agentOutput, "action");
  const message = normalizeStepText(
    safeReadRecordField(actionOutput, "message"),
    "Action output unavailable"
  );
  const extract = safeReadRecordField(actionOutput, "extract");

  return {
    thoughts,
    memory,
    action,
    message,
    extract,
    hasExtract: typeof extract !== "undefined",
  };
}

function getDomStateSummary(domState: A11yDOMState): string {
  try {
    const value = domState.domState;
    return typeof value === "string"
      ? value
      : formatUnknownError(value);
  } catch {
    return "DOM state unavailable";
  }
}

function safeSerializeForPrompt(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return truncatePromptText(
      typeof serialized === "string"
        ? serialized
        : formatUnknownError(value)
    );
  } catch {
    return truncatePromptText(formatUnknownError(value));
  }
}

function normalizeScrollInfo(value: unknown): [number, number] {
  if (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  ) {
    return [value[0], value[1]];
  }
  return [0, 0];
}

function getOpenTabsSummary(page: Page): string {
  try {
    const pages = page.context().pages();
    const pageEntries = pages.map((openPage, index) => ({ openPage, index }));
    let visibleEntries = pageEntries.slice(0, MAX_OPEN_TAB_ENTRIES);
    const currentEntry = pageEntries.find((entry) => entry.openPage === page);
    if (
      currentEntry &&
      MAX_OPEN_TAB_ENTRIES > 0 &&
      !visibleEntries.some((entry) => entry.openPage === page)
    ) {
      visibleEntries = [
        ...pageEntries.slice(0, Math.max(0, MAX_OPEN_TAB_ENTRIES - 1)),
        currentEntry,
      ];
    }

    const visibleIndexSet = new Set(visibleEntries.map((entry) => entry.index));
    const hiddenCount = Math.max(0, pages.length - visibleIndexSet.size);
    const tabLines = visibleEntries.map(({ openPage, index }) => {
      const currentMarker = openPage === page ? " (current)" : "";
      const tabUrl = (() => {
        try {
          return truncateTabUrl(openPage.url() || "about:blank");
        } catch {
          return "about:blank (url unavailable)";
        }
      })();
      return `[${index}] ${tabUrl}${currentMarker}`;
    });
    if (hiddenCount > 0) {
      tabLines.push(`... ${hiddenCount} more tabs omitted`);
    }
    return tabLines.join("\n");
  } catch {
    return "Open tabs unavailable";
  }
}

function getCurrentUrlSummary(page: Page): string {
  try {
    return truncateTabUrl(page.url() || "about:blank");
  } catch {
    return "Current URL unavailable";
  }
}

export const buildAgentStepMessages = async (
  baseMessages: HyperAgentMessage[],
  steps: AgentStep[],
  task: string,
  page: Page,
  domState: A11yDOMState,
  screenshot: string | undefined,
  variables: HyperVariable[]
): Promise<HyperAgentMessage[]> => {
  const messages = [...baseMessages];

  // Add the final goal section
  messages.push({
    role: "user",
    content: `=== Final Goal ===\n${truncatePromptText(task)}\n`,
  });

  // Add current URL section
  messages.push({
    role: "user",
    content: `=== Current URL ===\n${getCurrentUrlSummary(page)}\n`,
  });

  const openTabs = getOpenTabsSummary(page);
  messages.push({
    role: "user",
    content: `=== Open Tabs ===\n${openTabs || "No open tabs"}\n`,
  });

  // Add variables section
  const variablesContent = buildVariablesContent(variables);
  messages.push({
    role: "user",
    content: `=== Variables ===\n${variablesContent}\n`,
  });

  // Add previous actions section if there are steps
  if (steps.length > 0) {
    const relevantSteps =
      steps.length > MAX_HISTORY_STEPS
        ? steps.slice(-MAX_HISTORY_STEPS)
        : steps;
    const hiddenStepCount = steps.length - relevantSteps.length;
    const omittedSteps =
      hiddenStepCount > 0 ? steps.slice(0, hiddenStepCount) : [];

    messages.push({
      role: "user",
      content:
        hiddenStepCount > 0
          ? `=== Previous Actions ===\n(Showing latest ${relevantSteps.length} of ${steps.length} steps; ${hiddenStepCount} older steps omitted for context budget.)\n`
          : "=== Previous Actions ===\n",
    });
    if (hiddenStepCount > 0) {
      const omittedSummary = buildOmittedStepsSummary(omittedSteps);
      if (omittedSummary.length > 0) {
        messages.push({
          role: "user",
          content: `=== Earlier Actions Summary ===\n${omittedSummary}\n`,
        });
      }
    }
    for (const step of relevantSteps) {
      const {
        thoughts,
        memory,
        action,
        message,
        extract,
        hasExtract,
      } = getStepPromptData(step);
      messages.push({
        role: "assistant",
        content: `Thoughts: ${thoughts}\nMemory: ${memory}\nAction: ${safeSerializeForPrompt(action)}`,
      });
      messages.push({
        role: "user",
        content: hasExtract
          ? `${message} :\n ${safeSerializeForPrompt(extract)}`
          : message,
      });
    }
  }

  // Add elements section with DOM tree
  messages.push({
    role: "user",
    content: `=== Elements ===\n${truncateDomState(getDomStateSummary(domState))}\n`,
  });

  // Add page screenshot section (only if screenshot is available)
  if (screenshot) {
    const scrollInfo = await retry({ func: () => getScrollInfo(page) })
      .then((value) => normalizeScrollInfo(value))
      .catch(() => [0, 0] as [number, number]);
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: "=== Page Screenshot ===\n",
        },
        {
          type: "image",
          url: `data:image/png;base64,${screenshot}`,
          mimeType: "image/png",
        },
        {
          type: "text",
          text: `=== Page State ===\nPixels above: ${scrollInfo[0]}\nPixels below: ${scrollInfo[1]}\n`,
        },
      ],
    });
  }

  return messages;
};
