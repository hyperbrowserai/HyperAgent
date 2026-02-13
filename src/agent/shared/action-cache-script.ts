import { ActionCacheEntry } from "@/types";

interface CreateScriptFromActionCacheParams {
  taskId?: string;
  steps: ActionCacheEntry[];
}

const getSortStepIndex = (value: number): number =>
  Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;

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

const normalizeWaitMs = (value: unknown): number => {
  const parsed = asNumber(value);
  if (parsed === undefined) {
    return 1000;
  }
  return parsed >= 0 ? parsed : 1000;
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
  return parsed >= 0 ? parsed : undefined;
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
    const safeStepIndex = Number.isFinite(step.stepIndex) ? step.stepIndex : -1;

    if (step.actionType === "complete") {
      return `${indent}// Step ${safeStepIndex} (complete skipped in script)`;
    }

    if (step.actionType === "goToUrl") {
      const actionParams = isRecord(step.actionParams)
        ? step.actionParams
        : undefined;
      const argumentUrl = asNonEmptyTrimmedString(step.arguments?.[0]) ?? "";
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

    if (step.actionType === "refreshPage") {
      return `${indent}// Step ${safeStepIndex}
${indent}await page.reload({ waitUntil: "domcontentloaded" });`;
    }

    if (step.actionType === "wait") {
      const actionParams = isRecord(step.actionParams)
        ? step.actionParams
        : undefined;
      const waitMs = normalizeWaitMs(step.arguments?.[0] ?? actionParams?.duration);
      return `${indent}// Step ${safeStepIndex}
${indent}await page.waitForTimeout(${waitMs});`;
    }

    if (step.actionType === "waitForLoadState") {
      const actionParams = isRecord(step.actionParams)
        ? step.actionParams
        : undefined;
      const waitUntil = normalizeWaitUntil(
        step.arguments?.[0] ?? actionParams?.waitUntil
      );
      const timeoutMs = normalizeOptionalTimeoutMs(
        step.arguments?.[1] ?? actionParams?.timeout
      );
      if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) {
        return `${indent}// Step ${safeStepIndex}
${indent}await page.waitForLoadState(${JSON.stringify(waitUntil)}, { timeout: ${timeoutMs} });`;
      }
      return `${indent}// Step ${safeStepIndex}
${indent}await page.waitForLoadState(${JSON.stringify(waitUntil)});`;
    }

    if (step.actionType === "extract") {
      const extractInstruction = asNonEmptyTrimmedString(step.instruction);
      if (!extractInstruction) {
        return `${indent}// Step ${safeStepIndex} (extract skipped: missing instruction)`;
      }
      return `${indent}// Step ${safeStepIndex}
${indent}await page.extract(${JSON.stringify(extractInstruction)});`;
    }

    const normalizedMethod = normalizeHelperMethod(step.method);
    const call = normalizedMethod ? METHOD_TO_CALL[normalizedMethod] : undefined;
    if (call) {
      const normalizedXPath = asNonEmptyTrimmedString(step.xpath);
      if (!normalizedXPath) {
        return `${indent}// Step ${safeStepIndex} (unsupported actionType=${step.actionType}, method=${step.method ?? "N/A"}, reason=missing xpath)`;
      }
      const options: Record<string, unknown> = {};
      const performInstruction = asNonEmptyTrimmedString(step.instruction);
      if (performInstruction) {
        options.performInstruction = performInstruction;
      }
      if (
        step.frameIndex !== null &&
        step.frameIndex !== undefined &&
        step.frameIndex !== 0
      ) {
        options.frameIndex = step.frameIndex;
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
          ? `${argIndent}${JSON.stringify(step.arguments?.[0] ?? "")},`
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

    return `${indent}// Step ${safeStepIndex} (unsupported actionType=${step.actionType}, method=${step.method ?? "N/A"})`;
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
