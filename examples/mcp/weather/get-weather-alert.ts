/**
 * # Weather MCP Server Example
 *
 * This example demonstrates how to use HyperAgent with a MCP (Model Context Protocol) server
 * to browse the web, extract information, and use that information to query a separate API service.
 *
 * ## What This Example Does
 *
 * The agent performs a multi-step task that requires web browsing and data extraction:
 * 1. Navigates to a Wikipedia page listing US states by population
 * 2. Identifies the most populated state
 * 3. Uses the custom weather MCP server to find weather alerts for that state
 *
 * ## Prerequisites
 *
 * - Node.js environment
 * - OpenAI API key set in your .env file (OPENAI_API_KEY)
 *
 * ## MCP Server Configuration
 *
 * This example uses a custom MCP server (weather-server.js) that provides tools for:
 * - `get-alerts`: Fetches weather alerts for a specific state from the National Weather Service API
 * - `get-forecast`: Retrieves weather forecasts for specific coordinates
 *
 *
 * ## Debugging and Monitoring
 *
 * The example includes callback functions to monitor:
 * - Agent output: Raw output from the LLM agent
 * - Step execution: Each step the agent takes during the task
 *
 * ## Running the Example
 *
 * ```
 * yarn ts-node examples/mcp/weather/get-weather-alert.ts
 * ```
 *
 * ## Example Output
 *
 * The final output will include the most populated US state and a list of current weather alerts for that state.
 */

import dotenv from "dotenv";
import chalk from "chalk";
import path from "path";
// Removed LangChain import - using native SDK configuration
import HyperAgent from "@hyperbrowser/agent";

dotenv.config();

const TASK = `Go to https://en.wikipedia.org/wiki/List_of_U.S._states_and_territories_by_population and find the most populated state.
Then list 3 weather alerts for that state.`;

async function run() {
  console.log(chalk.cyan.bold("\n===== Running Task ====="));
  console.log(chalk.white(`Task: ${TASK}`));
  console.log(chalk.cyan.bold("=======================\n"));

  // Using native SDK configuration

  const mcpServerPath = path.join(__dirname, "/servers/weather-server.js");

  console.log(chalk.yellow("Creating Hyperbrowser Agent..."));

  try {
    const agent = new HyperAgent({
      llm: {
        provider: "openai",
        model: "gpt-4o",
      },
      debug: true,
    });

    await agent.initializeMCPClient({
      servers: [
        {
          command: "node",
          args: [mcpServerPath],
        },
      ],
    });

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
  } catch (error) {
    console.error(chalk.red("Error creating agent or executing task:"));
    console.error(
      chalk.red(error instanceof Error ? error.stack : String(error))
    );
  }
}

(async () => {
  try {
    await run();
  } catch (error) {
    console.error(chalk.red("Error:"), error);
    process.exit(1);
  }
})();
