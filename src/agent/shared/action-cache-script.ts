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

  const formatArguments = (args: unknown[] | undefined): string => {
    if (!args || args.length === 0) {
      return "[]";
    }
    if (args.length === 1) {
      return `[${JSON.stringify(args[0])}]`;
    }
    return `[\n${args
      .map((arg) => `        ${JSON.stringify(arg)},`)
      .join("\n")}\n      ]`;
  };

  const formatCachedAction = (step: ActionCacheEntry): string => {
    const fields = [
      `actionType: ${JSON.stringify(step.actionType)}`,
      step.method ? `method: ${JSON.stringify(step.method)}` : undefined,
      `arguments: ${formatArguments(step.arguments)}`,
      step.frameIndex !== undefined && step.frameIndex !== null
        ? `frameIndex: ${step.frameIndex}`
        : undefined,
      step.xpath ? `xpath: ${JSON.stringify(step.xpath)}` : undefined,
    ].filter(Boolean);

    return `{\n      ${fields.join(",\n      ")}\n    }`;
  };

  const stepSnippets = steps
    .map((step) => {
      if (step.actionType === "complete") {
        return `  // Step ${step.stepIndex} (complete skipped in script)`;
      }
      if (step.actionType === "goToUrl") {
        const urlArg =
          (step.arguments && step.arguments[0]) ||
          "https://example.com"; // fallback safety
        return `  // Step ${step.stepIndex}
  await page.goto(${JSON.stringify(
    urlArg
  )}, { waitUntil: "domcontentloaded" });`;
      }

      return `  // Step ${step.stepIndex}
  await page.perform(${JSON.stringify(step.instruction)}, {
    cachedAction: ${formatCachedAction(step)},
    maxSteps: 3,
  });`;
    })
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
