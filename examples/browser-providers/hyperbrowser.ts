/**
 * # Hyperbrowser Provider Example
 *
 * This example demonstrates how to configure and use HyperAgent with the Hyperbrowser
 * provider for web browsing tasks with proxy support.
 *
 * ## What This Example Does
 *
 * The agent performs a simple web search task that:
 * 1. Configures HyperAgent with Hyperbrowser-specific settings
 * 2. Enables proxy support for enhanced privacy and reliability
 * 3. Searches for and extracts specific information about a movie release date
 *
 * ## Prerequisites
 *
 * 1. Node.js environment
 * 2. OpenAI API key set in your .env file (OPENAI_API_KEY)
 *
 * ## Running the Example
 *
 * ```bash
 * yarn ts-node examples/browser-providers/hyperbrowser.ts
 * ```
 */

import "dotenv/config";
import { HyperAgent } from "@hyperbrowser/agent";
import { ChatOpenAI } from "@langchain/openai";
import chalk from "chalk";

async function runEval() {
  const llm = new ChatOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    model: "gpt-4o",
  });

  const agent = new HyperAgent({
    llm: llm,
    debug: true,
    browserProvider: "Hyperbrowser",
    hyperbrowserConfig: {
      hyperbrowserSessionOptions: {
        useProxy: true,
      },
    },
  });
  const result = await agent.executeTask(
    "Find the initial release date for Guardians of the Galaxy Vol. 3 the movie",
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
