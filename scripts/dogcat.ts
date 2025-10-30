// workflow.ts

import { HyperAgent } from "../src/agent";
import { HyperPage } from "../src/types/agent/types";

// Install all dependencies:
// pnpm add -D playwright tsx typescript @types/node
//
// Then install the browser binary:
// pnpm exec playwright install chromium

// Generated script for workflow 49bc9db5-e0c5-4fd1-9956-c64b68db69de
// Generated at 2025-10-27T23:39:52.578Z

async function runWorkflow() {
  let agent: HyperAgent | null = null;

  try {
    // Initialize HyperAgent
    console.log("Initializing HyperAgent...");
    agent = new HyperAgent({
      llm: {
        provider: "openai",
        model: "gpt-4o",
      },
      debug: true,
    });

    // Get the page instance
    const page: HyperPage = await agent.newPage();
    if (!page) {
      throw new Error("Failed to get page instance from HyperAgent");
    }

    const variables = {
      input1: "cats",
      input2: "dogs",
    };
    // Step 1: Navigate to URL
    console.log("Navigating to: https://www.bing.com/");
    await page.goto("https://www.bing.com/");

    // Step 2: Perform action using aiAction (single granular action, a11y mode)
    console.log(
      `Performing action: type ${variables.input1} into the search box`
    );
    await page.aiAction(`type ${variables.input1} into the search box`);

    // Step 3: Perform action using aiAction
    console.log(`Performing action: click the first search suggestion 'cats'`);
    await page.aiAction(`click the first search suggestion 'cats'`);

    // Step 4: Perform action using aiAction
    console.log(`Performing action: click the search box with 'cats' text`);
    await page.aiAction(`click the search box with 'cats' text`);

    // Step 5: Perform action using aiAction
    console.log(
      `Performing action: click the X button to clear the search box`
    );
    await page.aiAction(`click the X button to clear the search box`);

    // Step 6: Perform action using aiAction
    console.log(
      `Performing action: type ${variables.input2} into the search box`
    );
    await page.aiAction(`type ${variables.input2} into the search box`);

    // Step 7: Perform action using aiAction
    console.log(`Performing action: click the first search suggestion 'dogs'`);
    await page.aiAction(`click the first search suggestion 'dogs'`);

    // Step 8: Perform action using aiAction
    console.log(
      `Performing action: click the first search result 'Dog - Wikipedia'`
    );
    await page.aiAction(`click the first search result 'Dog - Wikipedia'`);

    console.log("Workflow completed successfully");
    await new Promise((resolve) => setTimeout(resolve, 5000));

    return { success: true };
  } catch (error) {
    console.error("Workflow failed:", error);
    return { success: false, error };
  } finally {
    // Clean up
    if (agent) {
      console.log("Closing HyperAgent connection.");
      try {
        await agent.closeAgent();
      } catch (err) {
        console.error("Error closing HyperAgent:", err);
      }
    }
  }
}

// Single execution
runWorkflow().then((result) => {
  console.log("Execution result:", result);
  process.exit(result.success ? 0 : 1);
});

export default runWorkflow;
