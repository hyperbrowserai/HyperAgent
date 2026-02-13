import { ActionCacheEntry } from "@/types";

interface CreateScriptFromActionCacheParams {
  taskId?: string;
  steps: ActionCacheEntry[];
}

const getSortStepIndex = (value: number): number =>
  Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;

const MAX_SCRIPT_WAIT_MS = 120_000;
const MAX_SCRIPT_TIMEOUT_MS = 120_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const asNonEmptyTrimmedString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const safeReadStepField = (
  step: ActionCacheEntry,
  field: keyof ActionCacheEntry
): unknown => {
  try {
    return (step as unknown as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
};

const safeReadArrayIndex = (value: unknown, index: number): unknown => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  try {
    return value[index];
  } catch {
    return undefined;
  }
};

const normalizeWaitMs = (value: unknown): number => {
  const parsed = asNumber(value);
  if (parsed === undefined) {
    return 1000;
  }
  if (parsed < 0) {
    return 1000;
  }
  return Math.min(parsed, MAX_SCRIPT_WAIT_MS);
};

const normalizeWaitUntil = (value: unknown): "domcontentloaded" | "load" | "networkidle" => {
  const parsed = asNonEmptyTrimmedString(value)?.toLowerCase();
  if (parsed === "load" || parsed === "networkidle") {
    return parsed;
  }
  return "domcontentloaded";
};

const normalizeOptionalTimeoutMs = (value: unknown): number | undefined => {
  const parsed = asNumber(value);
  if (parsed === undefined) {
    return undefined;
  }
  if (parsed < 0) {
    return undefined;
  }
  return Math.min(parsed, MAX_SCRIPT_TIMEOUT_MS);
};

export function createScriptFromActionCache(
  params: CreateScriptFromActionCacheParams
): string {
  const { steps } = params;

  const METHOD_TO_CALL: Record<
    string,
    { fn: string; needsValue?: boolean; valueName?: string }
  > = {
    click: { fn: "performClick" },
    fill: { fn: "performFill", needsValue: true, valueName: "text" },
    type: { fn: "performType", needsValue: true, valueName: "text" },
    press: { fn: "performPress", needsValue: true, valueName: "key" },
    selectOptionFromDropdown: {
      fn: "performSelectOption",
      needsValue: true,
      valueName: "option",
    },
    check: { fn: "performCheck" },
    uncheck: { fn: "performUncheck" },
    hover: { fn: "performHover" },
    scrollToElement: { fn: "performScrollToElement" },
    scrollToPercentage: {
      fn: "performScrollToPercentage",
      needsValue: true,
      valueName: "position",
    },
    nextChunk: { fn: "performNextChunk" },
    prevChunk: { fn: "performPrevChunk" },
  };
  const METHOD_TO_CALL_KEYS = Object.keys(METHOD_TO_CALL);
  const normalizeHelperMethod = (method: string | null | undefined): string | null => {
    const normalizedMethod = method?.trim().toLowerCase();
    if (!normalizedMethod) {
      return null;
    }
    return (
      METHOD_TO_CALL_KEYS.find(
        (candidate) => candidate.toLowerCase() === normalizedMethod
      ) ?? null
    );
  };

  const formatCall = (step: ActionCacheEntry): string => {
    const indent = "  ";
    const argIndent = `${indent}  `;
    const stepIndexValue = safeReadStepField(step, "stepIndex");
    const actionTypeValue = safeReadStepField(step, "actionType");
    const instructionValue = safeReadStepField(step, "instruction");
    const methodValue = safeReadStepField(step, "method");
    const xpathValue = safeReadStepField(step, "xpath");
    const frameIndexValue = safeReadStepField(step, "frameIndex");
    const argumentsValue = safeReadStepField(step, "arguments");
    const actionParamsValue = safeReadStepField(step, "actionParams");
    const safeStepIndex =
      typeof stepIndexValue === "number" && Number.isFinite(stepIndexValue)
        ? stepIndexValue
        : -1;
    const actionType = isNonEmptyString(actionTypeValue)
      ? actionTypeValue
      : "unknown";

    if (actionType === "complete") {
      return `${indent}// Step ${safeStepIndex} (complete skipped in script)`;
    }

    if (actionType === "goToUrl") {
      const actionParams = isRecord(actionParamsValue)
        ? actionParamsValue
        : undefined;
      const argumentUrl =
        asNonEmptyTrimmedString(safeReadArrayIndex(argumentsValue, 0)) ?? "";
      const urlArg =
        argumentUrl ||
        (asNonEmptyTrimmedString(actionParams?.url) ?? "") ||
        "https://example.com";
      return `${indent}// Step ${safeStepIndex}
${indent}await page.goto(
${argIndent}${JSON.stringify(urlArg)},
${argIndent}{ waitUntil: "domcontentloaded" }
${indent});`;
    }

    if (actionType === "refreshPage") {
      return `${indent}// Step ${safeStepIndex}
${indent}await page.reload({ waitUntil: "domcontentloaded" });`;
    }

    if (actionType === "wait") {
      const actionParams = isRecord(actionParamsValue)
        ? actionParamsValue
        : undefined;
      const waitMs = normalizeWaitMs(
        safeReadArrayIndex(argumentsValue, 0) ?? actionParams?.duration
      );
      return `${indent}// Step ${safeStepIndex}
${indent}await page.waitForTimeout(${waitMs});`;
    }

    if (actionType === "waitForLoadState") {
      const actionParams = isRecord(actionParamsValue)
        ? actionParamsValue
        : undefined;
      const waitUntil = normalizeWaitUntil(
        safeReadArrayIndex(argumentsValue, 0) ?? actionParams?.waitUntil
      );
      const timeoutMs = normalizeOptionalTimeoutMs(
        safeReadArrayIndex(argumentsValue, 1) ?? actionParams?.timeout
      );
      if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) {
        return `${indent}// Step ${safeStepIndex}
${indent}await page.waitForLoadState(${JSON.stringify(waitUntil)}, { timeout: ${timeoutMs} });`;
      }
      return `${indent}// Step ${safeStepIndex}
${indent}await page.waitForLoadState(${JSON.stringify(waitUntil)});`;
    }

    if (actionType === "extract") {
      const extractInstruction = asNonEmptyTrimmedString(instructionValue);
      if (!extractInstruction) {
        return `${indent}// Step ${safeStepIndex} (extract skipped: missing instruction)`;
      }
      return `${indent}// Step ${safeStepIndex}
${indent}await page.extract(${JSON.stringify(extractInstruction)});`;
    }

    const normalizedMethod = normalizeHelperMethod(
      typeof methodValue === "string" ? methodValue : null
    );
    const call = normalizedMethod ? METHOD_TO_CALL[normalizedMethod] : undefined;
    if (call) {
      const normalizedXPath = asNonEmptyTrimmedString(xpathValue);
      if (!normalizedXPath) {
        return `${indent}// Step ${safeStepIndex} (unsupported actionType=${actionType}, method=${typeof methodValue === "string" ? methodValue : "N/A"}, reason=missing xpath)`;
      }
      const options: Record<string, unknown> = {};
      const performInstruction = asNonEmptyTrimmedString(instructionValue);
      if (performInstruction) {
        options.performInstruction = performInstruction;
      }
      if (
        typeof frameIndexValue === "number" &&
        Number.isFinite(frameIndexValue) &&
        frameIndexValue !== 0
      ) {
        options.frameIndex = frameIndexValue;
      }

      const optionEntries = Object.entries(options).map(
        ([key, value]) => `${argIndent}  ${key}: ${JSON.stringify(value)},`
      );
      const optionsBlock =
        optionEntries.length > 0
          ? `${argIndent}{\n${optionEntries.join("\n")}\n${argIndent}}`
          : "";

      const callArgs = [
        `${argIndent}${JSON.stringify(normalizedXPath)},`,
        call.needsValue
          ? `${argIndent}${JSON.stringify(safeReadArrayIndex(argumentsValue, 0) ?? "")},`
          : null,
        optionsBlock ? `${optionsBlock},` : null,
      ]
        .filter(Boolean)
        .join("\n");

      return `${indent}// Step ${safeStepIndex}
${indent}await page.${call.fn}(
${callArgs}
${indent});`;
    }

    return `${indent}// Step ${safeStepIndex} (unsupported actionType=${actionType}, method=${typeof methodValue === "string" ? methodValue : "N/A"})`;
  };

  const stepSnippets = [...steps]
    .sort((a, b) => getSortStepIndex(a.stepIndex) - getSortStepIndex(b.stepIndex))
    .map((step) => formatCall(step))
    .join("\n\n");

  const script = `import { HyperAgent } from "@hyperbrowser/agent";
async function main() {
  const agent = new HyperAgent({
    // Configure your LLM/API keys
  });

  const page = await agent.newPage();

${stepSnippets}

  await agent.closeAgent();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;

  return script;
}
