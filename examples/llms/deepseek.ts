/**
 * # DeepSeek LLM Integration Example
 *
 * This example demonstrates how to configure and use HyperAgent with DeepSeek's
 * language models for web automation tasks.
 *
 * ## What This Example Does
 *
 * The agent performs a web scraping task that:
 * 1. Configures HyperAgent with DeepSeek's model
 * 2. Navigates to Hacker News
 * 3. Searches for and extracts information about "Show HN" posts
 *
 * ## Prerequisites
 *
 * 1. Node.js environment
 * 2. DeepSeek API key set in your .env file (DEEPSEEK_API_KEY)
 *
 * ## Running the Example
 *
 * ```bash
 * yarn ts-node -r tsconfig-paths/register examples/llms/deepseek.ts
 * ```
 */

import "dotenv/config";
import HyperAgent from "@hyperbrowser/agent";

import chalk from "chalk";

const TASK =
  "Go to hackernews, and find if there's any SHOW HN post up there. If it is, then tell me the title of the post.";

async function runEval() {
  const agent = new HyperAgent({
    llm: {
      provider: "deepseek",
      model: "deepseek-chat",
    },
    debug: true,
  });

  console.log(`\n${chalk.green("Running agent with DeepSeek")}\n`);

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
