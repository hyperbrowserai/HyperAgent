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
  const variablesContent =
    variables.length > 0
      ? variables
          .map(
            (v) =>
              `<<${v.key}>> - ${truncatePromptText(v.description)} | current value: ${safeSerializeForPrompt(v.value)}`
          )
          .join("\n")
      : "No variables set";
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

    messages.push({
      role: "user",
      content:
        hiddenStepCount > 0
          ? `=== Previous Actions ===\n(Showing latest ${relevantSteps.length} of ${steps.length} steps; ${hiddenStepCount} older steps omitted for context budget.)\n`
          : "=== Previous Actions ===\n",
    });
    for (const step of relevantSteps) {
      const { thoughts, memory, action } = step.agentOutput;
      messages.push({
        role: "assistant",
        content: `Thoughts: ${truncatePromptText(thoughts)}\nMemory: ${truncatePromptText(
          memory
        )}\nAction: ${safeSerializeForPrompt(
          action
        )}`,
      });
      const actionResult = step.actionOutput;
      messages.push({
        role: "user",
        content: actionResult.extract
          ? `${truncatePromptText(actionResult.message)} :\n ${safeSerializeForPrompt(actionResult.extract)}`
          : truncatePromptText(actionResult.message),
      });
    }
  }

  // Add elements section with DOM tree
  messages.push({
    role: "user",
    content: `=== Elements ===\n${truncateDomState(domState.domState)}\n`,
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
