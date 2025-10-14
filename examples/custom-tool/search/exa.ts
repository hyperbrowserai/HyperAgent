/**
 * # Custom Search Tool Example with Exa
 *
 * This example demonstrates how to create and use a custom search tool with HyperAgent
 * using the Exa search API to perform web searches and process the results.
 *
 * ## What This Example Does
 *
 * The agent performs a multi-step task that showcases custom tool integration:
 * 1. Defines a custom search action using the Exa API
 * 2. Creates a schema for the search parameters using Zod
 * 3. Implements a search function that returns formatted results with titles, URLs, and relevance scores
 * 4. Demonstrates the tool usage with a complex travel planning task for Tokyo that:
 *    - Searches for relevant information about Tokyo attractions
 *    - Analyzes search results and filters for relevance
 *    - Navigates to selected URLs to extract detailed information
 *    - Compiles recommendations based on uniqueness and frequency
 *
 * ## Prerequisites
 *
 * 1. Node.js environment
 * 2. OpenAI API key set in your .env file (OPENAI_API_KEY)
 * 3. Exa API key set in your .env file (EXA_API_KEY)
 *
 * ## Custom Tool Configuration
 *
 * The example includes:
 * - Custom search action definition with Zod schema validation
 * - Integration with Exa search API
 * - Formatted result output with relevance scoring
 *
 * ## Running the Example
 *
 * ```bash
 * yarn ts-node -r tsconfig-paths/register examples/custom-tool/search/exa.ts
 * ```
 *
 * ## Example Output
 *
 * The final output will include a detailed trip plan for Tokyo based on
 * searched and analyzed web content, with recommended places and their details.
 */

import "dotenv/config";
import HyperAgent from "@hyperbrowser/agent";
import {
  AgentActionDefinition,
  ActionContext,
  ActionOutput,
} from "@hyperbrowser/agent/types";
import chalk from "chalk";
// Removed LangChain import - using native SDK configuration
import Exa from "exa-js";

import * as z from "zod";

const exaInstance = new Exa(process.env.EXA_API_KEY);

const searchSchema = z
  .object({
    search: z
      .string()
      .describe(
        "The search query for something you want to search about. Keep the search query concise and to-the-point."
      ),
  })
  .describe("Search and return the results for a given query.");

export const RunSearchActionDefinition: AgentActionDefinition = {
  type: "perform_search",
  actionParams: searchSchema,
  run: async function (
    ctx: ActionContext,
    params: z.infer<typeof searchSchema>
  ): Promise<ActionOutput> {
    const results = (await exaInstance.search(params.search, {})).results
      .map(
        (res) =>
          `title: ${res.title} || url: ${res.url} || relevance: ${res.score}`
      )
      .join("\n");

    return {
      success: true,
      message: `Succesfully performed search for query ${params.search}. Got results: \n${results}`,
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
    customActions: [RunSearchActionDefinition],
  });

  const result = await agent.executeTask(
    `Make me a trip plan for Tokyo. 
    Steps:
    
    - Peform search about the place and things to see there using the 'perform_search' tool.
    - Analyze part of the urls provided, filtering results for relevance, and information and collecting a subset of urls that you think warrant further examination.
    - For each page that you've 
        - Navigate to that url
        - Extract information about trip recommendations
        - You must do this in order. Navigate to a single page, and then perform extraction on that page. Do not perform multiple navigations one after another.
    - Narrow down on places based on uniqueness, frequency of recommendation, and whatever else you feel is valuable.
    - Return to me a list of places you recommend, and their details (if any)`,
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
