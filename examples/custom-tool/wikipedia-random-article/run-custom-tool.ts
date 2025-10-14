/**
 * # Custom Wikipedia Random Article Tool Example
 * 
 * This example demonstrates how to create a simple custom tool for HyperAgent
 * that navigates to random Wikipedia articles and extracts their content.
 * 
 * ## What This Example Does
 * 
 * The agent performs a straightforward task using a custom tool that:
 * 1. Defines a custom action to navigate to Wikipedia's random article page
 * 2. Retrieves the page title and URL
 * 3. Extracts and describes the content of the randomly selected article
 * 
 * ## Prerequisites
 * 
 * 1. Node.js environment
 * 2. OpenAI API key set in your .env file (OPENAI_API_KEY)
 * 
 * ## Running the Example
 * 
 * ```bash
 * yarn ts-node -r tsconfig-paths/register examples/custom-tool/wikipedia-random-article/run-custom-tool.ts
 * ```
 */

import "dotenv/config";
import { HyperAgent } from "@hyperbrowser/agent";
import {
  AgentActionDefinition,
  ActionContext,
  ActionOutput,
} from "@hyperbrowser/agent/types";
import chalk from "chalk";
// Removed LangChain import - using native SDK configuration

import * as z from "zod";

export const GoToWikipediaActionDefinition: AgentActionDefinition = {
  type: "go_to_random_wikipedia_page",
  actionParams: z
    .object({})
    .describe(
      "Navigate to a random wikipedia page and return the title and url of the page."
    ),
  run: async function (ctx: ActionContext): Promise<ActionOutput> {
    await ctx.page.goto("https://en.wikipedia.org/wiki/Special:Random", {
      waitUntil: "domcontentloaded",
    });

    const url = ctx.page.url();
    const title = await ctx.page.title();
    return {
      success: true,
      message: `Succesfully navigated to URL: ${url} and title: ${title}`,
    };
  },
};

async function runEval() {
  console.log(chalk.cyan.bold("\n===== Running Custom Tool Example ====="));

  const agent = new HyperAgent({
    llm: {
      provider: "openai",
      model: "gpt-4o",
    },
    debug: true,
    customActions: [GoToWikipediaActionDefinition],
  });

  const result = await agent.executeTask(
    "Navigate to a random wikipedia page, and describe to me the contents of that page.",
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
