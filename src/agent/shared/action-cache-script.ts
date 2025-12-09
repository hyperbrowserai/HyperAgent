import { ActionCacheEntry } from "@/types";

interface CreateScriptFromActionCacheParams {
  taskId?: string;
  steps: ActionCacheEntry[];
}

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

  const formatCall = (step: ActionCacheEntry): string => {
    const indent = "  ";
    const argIndent = `${indent}  `;

    if (step.actionType === "complete") {
      return `${indent}// Step ${step.stepIndex} (complete skipped in script)`;
    }

    if (step.actionType === "goToUrl") {
      const urlArg =
        (step.arguments && step.arguments[0]) || "https://example.com";
      return `${indent}// Step ${step.stepIndex}
${indent}await page.goto(
${argIndent}${JSON.stringify(urlArg)},
${argIndent}{ waitUntil: "domcontentloaded" }
${indent});`;
    }

    if (step.actionType === "refreshPage") {
      return `${indent}// Step ${step.stepIndex}
${indent}await page.reload({ waitUntil: "domcontentloaded" });`;
    }

    if (step.actionType === "wait") {
      const waitMs =
        (step.arguments && Number(step.arguments[0])) ||
        (step.actionParams as any)?.duration ||
        1000;
      return `${indent}// Step ${step.stepIndex}
${indent}await page.waitForTimeout(${waitMs});`;
    }

    if (step.actionType === "extract") {
      return `${indent}// Step ${step.stepIndex}
${indent}await page.extract("${step.instruction}");`;
    }

    const call = step.method ? METHOD_TO_CALL[step.method] : undefined;
    if (call) {
      const args: string[] = [];
      args.push(JSON.stringify(step.xpath));
      if (call.needsValue) {
        const value = step.arguments?.[0] ?? "";
        args.push(JSON.stringify(value));
      }
      const options: Record<string, unknown> = {};
      if (step.instruction) {
        options.performInstruction = step.instruction;
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
        `${argIndent}${JSON.stringify(step.xpath)},`,
        call.needsValue
          ? `${argIndent}${JSON.stringify(step.arguments?.[0] ?? "")},`
          : null,
        optionsBlock ? `${optionsBlock},` : null,
      ]
        .filter(Boolean)
        .join("\n");

      return `${indent}// Step ${step.stepIndex}
${indent}await page.${call.fn}(
${callArgs}
${indent});`;
    }

    return `${indent}// Step ${step.stepIndex} (unsupported actionType=${step.actionType}, method=${step.method ?? "N/A"})`;
  };

  const stepSnippets = steps.map((step) => formatCall(step)).join("\n\n");

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
