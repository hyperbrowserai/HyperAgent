/**
 * # Google Sheets MCP Server Example
 *
 * This example demonstrates how to use HyperAgent with the Composio Googlesheets MCP server
 * to connect to Google Sheets, create a new spreadsheet, and populate it with data scraped from the web.
 *
 * ## What This Example Does
 *
 * The agent performs a multi-step task that requires web browsing and Google Sheets integration:
 * 1. Checks if there is an active connection to Composio Googlesheets MCP server
 * 2. If no connection exists, initiates a connection and waits for the user to authenticate
 * 3. Creates a new spreadsheet titled "Most Populated States"
 * 4. Navigates to Wikipedia to gather data on the 5 most populous US states
 * 5. Adds the data to the created spreadsheet
 *
 * ## Prerequisites
 *
 * 1. Node.js environment
 * 2. OpenAI API key set in your .env file (OPENAI_API_KEY)
 * 3. Need to have a Composio account, can sign up at https://app.composio.dev
 *    - Go to this link and get your secure MCP URL (you just need the URL part from the command): https://mcp.composio.dev/googlesheets
 *    - You will use the url to run the script, for example:
 *    ```
 *    yarn ts-node tsconfig-paths/register examples/mcp/google-sheets/most-populated-states.ts <your-mcp-url>
 *    ```
 *    - When running for the first time, there will be no active connection so you will need to login
 *      with Google OAUTH at the link provided by the agent to authenticate
 *
 * ## MCP Server Configuration
 *
 * This example uses the Composio Googlesheets MCP server which provides tools for:
 * - `GOOGLESHEETS_CHECK_ACTIVE_CONNECTION`: Verifies if there's an active connection to Google Sheets
 * - `GOOGLESHEETS_INITIATE_CONNECTION`: Starts the authentication process for Google Sheets
 * - `GOOGLESHEETS_CREATE_GOOGLE_SHEET1`: Creates a new Google Sheet
 * - `GOOGLESHEETS_SHEET_FROM_JSON`: Converts JSON data to a Google Sheet format
 * - `GOOGLESHEETS_BATCH_UPDATE`: Updates multiple cells in a spreadsheet
 * - `GOOGLESHEETS_GET_SPREADSHEET_INFO`: Retrieves information about a spreadsheet
 * - `GOOGLESHEETS_LOOKUP_SPREADSHEET_ROW`: Looks up a specific row in a spreadsheet
 * - `GOOGLESHEETS_BATCH_GET`: Gets values from multiple ranges in a spreadsheet
 * - `GOOGLESHEETS_GET_SHEET_NAMES`: Gets the names of all sheets in a spreadsheet
 * - `GOOGLESHEETS_CLEAR_VALUES`: Clears values from a range in a spreadsheet
 * - `GOOGLESHEETS_GET_REQUIRED_PARAMETERS`: Gets required parameters for Google Sheets operations
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
 * yarn ts-node examples/mcp/google-sheets/most-populated-states.ts <your-mcp-url>
 * ```
 *
 * ## Example Output
 *
 * The final output will include confirmation that the agent has successfully created a new Google Sheet
 * and populated it with information about the top 5 most populous US states.
 */

import dotenv from "dotenv";
import chalk from "chalk";
// Removed LangChain import - using native SDK configuration
import HyperAgent from "@hyperbrowser/agent";

dotenv.config();

const TASK = `1. Run GOOGLESHEETS_CHECK_ACTIVE_CONNECTION to check if there is an active connection.
2. If there is an active connection, go to 4. Otherwise, go to 3.
3. Run GOOGLESHEETS_INITIATE_CONNECTION and output the the auth link to the user, then wait for the connection to be active.
4. Create a new spreadsheet titled "Most Populated States".
5. Go to https://en.wikipedia.org/wiki/List_of_U.S._states_and_territories_by_population and get the data on the top 5 most populous states from the table.
6. Add that information to the spreadsheet properly.
Make sure that the data is well formatted and the columns are all there.`;

async function run(mcpUrl: string) {
  console.log(chalk.cyan.bold("\n===== Running Task ====="));
  console.log(chalk.white(`Task: ${TASK}`));
  console.log(chalk.cyan.bold("=======================\n"));

  console.log(chalk.yellow("Initializing OpenAI LLM..."));
  // Using native SDK configuration

  console.log(chalk.yellow("Creating HyperAgent..."));

  try {
    const agent = new HyperAgent({
      llm: {
      provider: "openai",
      model: "gpt-4o",
    },
      debug: true,
    });
    console.log(chalk.green("Agent created successfully"));

    console.log(
      chalk.yellow("Connecting to Composio Googlesheets MCP server...")
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
        "Connected to Composio Googlesheets MCP server, executing task..."
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
