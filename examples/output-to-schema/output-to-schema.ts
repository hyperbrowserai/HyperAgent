/**
 * # Output Schema Example
 *
 * This example demonstrates how to use HyperAgent with a defined output schema
 * to ensure structured and validated responses from the agent.
 *
 * ## What This Example Does
 *
 * The agent performs a task with structured output that:
 * 1. Defines a Zod schema for the expected output format
 * 2. Performs actions to complete the specified task
 * 3. Returns movie information in a structured format specified
 *
 * ## Prerequisites
 *
 * 1. Node.js environment
 * 2. OpenAI API key set in your .env file (OPENAI_API_KEY)
 *
 * ## Running the Example
 *
 * ```bash
 * yarn ts-node -r tsconfig-paths/register examples/output-to-schema/output-to-schema.ts
 * ```
 */

import "dotenv/config";
import { HyperAgent } from "@hyperbrowser/agent";

import chalk from "chalk";
import { sleep } from "../../src/utils/sleep";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

const TASK =
  "Find the initial release date for Guardians of the Galaxy Vol. 3 the movie";

async function runEval() {
  const llm = new ChatOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    model: "gpt-4o",
  });

  const agent = new HyperAgent({
    llm: llm,
    debug: true,
  });

  await sleep(1000);
  const result = await agent.executeTask(TASK, {
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
    outputSchema: z.object({
      releaseDate: z.string().describe("Release date in YYYY-MM-DD format"),
      titleName: z.string(),
    }),
  });
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
