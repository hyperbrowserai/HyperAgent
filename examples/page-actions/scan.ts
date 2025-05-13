/**
 * # Page Scan Example
 *
 * This example demonstrates how to use HyperAgent to scan a page to get all (or atleast most)
 * actions that can be performed on that page.
 *
 * ## Prerequisites
 *
 * 1. Node.js environment
 * 2. OpenAI API key set in your .env file (OPENAI_API_KEY)
 *
 * ## Running the Example
 *
 * ```bash
 * yarn ts-node -r tsconfig-paths/register examples/page-actions/scan.ts <url>
 * ```
 */

import "dotenv/config";
import { HyperAgent } from "@hyperbrowser/agent";

import chalk from "chalk";
import { ChatOpenAI } from "@langchain/openai";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runEval(url: string) {
  if (!url) {
    throw new Error("Please provide a URL as a command line argument");
  }

  const llm = new ChatOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    model: "gpt-4o",
  });

  const agent = new HyperAgent({
    llm: llm,
    debug: true,
  });

  const page = await agent.newPage();
  await page.goto(url);
  await sleep(5_000);
  console.log("Done with page.");
  const result = await page.scan();
  await agent.closeAgent();
  console.log(chalk.green.bold("\nResult:"));
  console.log(chalk.white(JSON.stringify(result, null, 2)));
  return result;
}

(async () => {
  const url = process.argv[process.argv.length - 1];
  await runEval(url);
})().catch((error) => {
  console.error(chalk.red("Error:"), error);
  process.exit(1);
});
