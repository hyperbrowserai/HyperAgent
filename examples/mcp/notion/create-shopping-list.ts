/**
 * # Notion MCP Server Example
 *
 * This example demonstrates how to use HyperAgent with the Composio Notion MCP server
 * to connect to Notion, create a new page, and populate it with ingredients for a recipe scraped from allrecipes.
 *
 * ## What This Example Does
 *
 * The agent performs a multi-step task that requires web browsing and Notion MCP:
 * 1. Checks if there is an active connection to Composio Notion MCP server
 * 2. If no connection exists, initiates a connection and waits for the user to authenticate
 * 3. Creates a new notion page titled "{{RECIPE}} ingredients"
 * 4. Navigates to allrecipes and finds a recipe matching the criterias
 * 5. Adds the data to the created spreadsheet
 *
 * ## Prerequisites
 *
 * 1. Node.js environment
 * 2. OpenAI API key set in your .env file (OPENAI_API_KEY)
 * 3. Need to have a Composio account, can sign up at https://app.composio.dev
 *    - Go to this link and get your secure MCP URL (you just need the URL part from the command): https://mcp.composio.dev/notion
 *    - You will use the url to run the script, for example:
 *    ```
 *    yarn ts-node examples/mcp/notion/create-shoppping-list.ts <your-mcp-url>
 *    ```
 *    - When running for the first time, there will be no active connection so you will need to login
 *      with Notion OAUTH at the link provided by the agent to authenticate
 *
 * ## MCP Server Configuration
 *
 * This example uses the Composio Notion MCP server which provides tools for a number of use cases. We will be using: :
 * - `NOTION_CHECK_ACTIVE_CONNECTION`: Verifies if there's an active connection to Notion
 * - `NOTION_INITIATE_CONNECTION`: Starts the authentication process for Notion
 * - `NOTION_ADD_PAGE_CONTENT`: Adds a single content block to a Notion page
 * - `NOTION_CREATE_PAGE`: Creates a new page in Notion
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
 * yarn ts-node examples/mcp/notion/create-shoppping-list.ts <your-mcp-url>
 * ```
 *
 * ## Example Output
 *
 * The final output will include confirmation that the agent has successfully created a new Notion Page
 * and populated it with the ingredients for a recipe.
 */

import dotenv from "dotenv";
import chalk from "chalk";
// Removed LangChain import - using native SDK configuration
import HyperbrowserAgent from "@hyperbrowser/agent";

dotenv.config();

const TASK = `
Go to allrecipes and find a suitable recipe for Salsa verde with more than 100 ratings. Then insert each ingredient into a notion page. Don't get the trivial ingredients like salt, water, or pepper.


## Steps to insert into a notion page:

1. Run NOTION_CHECK_ACTIVE_CONNECTION to check if there is an active connection.
2. If there is an active connection, go to 4. Otherwise, go to 3.
3. Run NOTION_INITIATE_CONNECTION and output the the auth link to the user, then wait for the connection to be active.
4. Create a new notion page title - {{RECIPE}} Ingredients
5. Go to allrecipes, find a suitable recipe for {{RECIPE}}, and get it's ingredients
6. For each ingredient, call NOTION_ADD_PAGE_CONTENT to insert a single ingredient

Make sure that the data is well formatted and the columns are all there.`;

async function run(mcpUrl: string) {
  console.log(chalk.cyan.bold("\n===== Running Task ====="));
  console.log(chalk.white(`Task: ${TASK}`));
  console.log(chalk.cyan.bold("=======================\n"));

  console.log(chalk.yellow("Initializing OpenAI LLM..."));
  // Using native SDK configuration

  console.log(chalk.yellow("Creating Hyperbrowser Agent..."));

  try {
    const agent = new HyperbrowserAgent({
      llm: {
      provider: "openai",
      model: "gpt-4o",
    },
      debug: true,
    });
    console.log(chalk.green("Agent created successfully"));

    console.log(
      chalk.yellow("Connecting to Composio Notion MCP server...")
    );
    await agent.initializeMCPClient({
      servers: [
        {
          command: "npx",
          args: ["@composio/mcp@latest", "start", "--url", mcpUrl],
          env: {
            npm_config_yes: "true",
          },
        },
      ],
    });
    console.log(
      chalk.green(
        "Connected to Composio Notion MCP server, executing task..."
      )
    );

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
    console.error(chalk.red.bold("Error creating agent or executing task:"));
    console.error(
      chalk.red(error instanceof Error ? error.stack : String(error))
    );
  }
}

(async () => {
  try {
    if (process.argv.length < 3) {
      console.error(
        chalk.red("Error: Please provide your MCP URL as an argument")
      );
      process.exit(1);
    }
    await run(process.argv[2]);
  } catch (error) {
    console.error(chalk.red("Error:"), error);
    process.exit(1);
  }
})();
