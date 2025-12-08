import fs from "fs";
import path from "path";
import { ActionCacheEntry } from "@/types";

interface CreateScriptFromActionCacheParams {
  taskId?: string;
  steps: ActionCacheEntry[];
}

export function createScriptFromActionCache(
  params: CreateScriptFromActionCacheParams
): string {
  const { taskId, steps } = params;
  const id =
    taskId && taskId.length > 0
      ? taskId
      : new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(process.cwd(), "action-cache-scripts", id);
  fs.mkdirSync(dir, { recursive: true });

const METHOD_TO_CALL: Record<string, { fn: string; needsValue?: boolean; valueName?: string }> = {
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
  if (step.actionType === "complete") {
    return `  // Step ${step.stepIndex} (complete skipped in script)`;
  }

  if (step.actionType === "goToUrl") {
    const urlArg =
      (step.arguments && step.arguments[0]) || "https://example.com";
    return `  // Step ${step.stepIndex}
  await page.goto(${JSON.stringify(
    urlArg
  )}, { waitUntil: "domcontentloaded" });`;
  }

  const call = step.method ? METHOD_TO_CALL[step.method] : undefined;
  if (call) {
    const args: string[] = [];
    args.push(JSON.stringify(step.xpath));
    if (call.needsValue) {
      const value = step.arguments?.[0] ?? "";
      args.push(JSON.stringify(value));
    }
    const options: Record<string, unknown> = {
      performInstruction: step.instruction,
    };
    if (step.frameIndex !== null && step.frameIndex !== undefined && step.frameIndex !== 0) {
      options.frameIndex = step.frameIndex;
    }
    const hasOptions =
      options.performInstruction !== undefined ||
      options.frameIndex !== undefined;
    if (hasOptions) {
      args.push(JSON.stringify(options));
    }

    return `  // Step ${step.stepIndex}
  await page.${call.fn}(${args.join(", ")});`;
  }

  // Fallback to perform with cachedAction if no helper mapping exists
  const cached = {
    actionType: step.actionType,
    method: step.method,
    arguments: step.arguments ?? [],
    frameIndex: step.frameIndex ?? 0,
    xpath: step.xpath,
    elementId: step.elementId,
  };
  return `  // Step ${step.stepIndex}
  await page.perform(${JSON.stringify(step.instruction)}, {
    cachedAction: ${JSON.stringify(cached, null, 2)
      .split("\n")
      .map((line, idx) => (idx === 0 ? line : "    " + line))
      .join("\n")},
  });`;
};

const stepSnippets = steps
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

  const outPath = path.join(dir, "run-cached-actions.ts");
  fs.writeFileSync(outPath, script);
  return outPath;
}
