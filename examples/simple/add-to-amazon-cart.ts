/**
 * # Simple Amazon Cart Example
 * 
 * This example demonstrates how to use HyperAgent to automate a basic
 * e-commerce task on Amazon.com.
 * 
 * ## What This Example Does
 * 
 * The agent performs a simple shopping task that:
 * 1. Navigates to Amazon.com
 * 2. Searches for a specific product
 * 3. Adds an item to the cart that matches the specific requirements (only a single item)
 * 
 * ## Prerequisites
 * 
 * 1. Node.js environment
 * 2. OpenAI API key set in your .env file (OPENAI_API_KEY)
 * 
 * ## Running the Example
 * 
 * ```bash
 * yarn ts-node -r tsconfig-paths/register examples/simple/add-to-amazon-cart.ts
 * ```
 */

import "dotenv/config";
import { HyperAgent } from "@hyperbrowser/agent";
import chalk from "chalk";

async function runEval() {
  console.log(chalk.cyan.bold("\n===== Running Add to amazon Example ====="));

  const agent = new HyperAgent({
    llm: {
      provider: "openai",
      model: "gpt-4o",
    },
  });

  const result = await agent.executeTask(
    "Navigate to amazon.com, and add the one chip challenge to my cart. Add only the version containing a single item, not multiple items. Once you have added a single product, and do not get any sort of failure form that addition, finish up.",
    {
      debugOnAgentOutput: (agentOutput) => {
        console.log("\n" + chalk.cyan.bold("===== AGENT OUTPUT ====="));
        console.dir(agentOutput, { depth: null, colors: true });
        console.log(chalk.cyan.bold("===============") + "\n");
      },
      onStep: (step) => {
        console.log("\n" + chalk.cyan.bold(`===== STEP ${step.idx} =====`));
        console.dir(step, { depth: null, colors: true });
        console.log(chalk.cyan.bold("===============") + "\n");
      },
    }
  );
  await agent.closeAgent();
  console.log(chalk.green.bold("\nResult:"));
  console.log(chalk.white(result.output));
  return result;
}

(async () => {
  await runEval();
})().catch((error) => {
  console.error(chalk.red("Error:"), error);
  process.exit(1);
});
