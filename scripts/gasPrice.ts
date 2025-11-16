// workflow.ts

import "dotenv/config";
import { HyperPage } from "../src/types/agent/types";
import { HyperAgent } from "../src/agent";

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
        provider: "anthropic",
        model: "claude-sonnet-4-0",
      },
      debug: true,
      cdpActions: true,
      debugOptions: {
        cdpSessions: true,
        traceWait: true,
        profileDomCapture: true,
      },
    });

    // Get the page instance
    const page: HyperPage = await agent.newPage();
    if (!page) {
      throw new Error("Failed to get page instance from HyperAgent");
    }

    await page.goto("https://www.google.com/maps");

    // Step 2: Perform action
    console.log(`Performing action: click the search box`);
    await page.aiAction(`click the search box`);

    // Step 3: Perform action
    console.log(`Performing action: click the directions button`);
    await page.aiAction(`click the directions button`);

    // Step 4: Perform action
    console.log(
      `Performing action: type 'San Francisco' into the starting point field`
    );
    await page.aiAction(`type 'San Francisco' into the starting point field`);

    // Step 5: Perform action
    console.log(
      `Performing action: type 'Los Angeles' into the destination field`
    );
    await page.aiAction(`type 'Los Angeles' into the destination field`);

    // Step 6: Perform action
    console.log(`Performing action: click the 'Los Angeles CA' option`);
    await page.aiAction(`click the 'Los Angeles CA' option`);

    // Step 7: Perform action
    console.log(`Performing action: click the Gas button`);
    await page.aiAction(`click the Gas button`);

    // Scroll: Scrolled down 300 pixels
    await page.aiAction(`Scroll down to bottom`);

    // Scroll: Scrolled down 500 pixels
    await page.aiAction(`Scroll down to bottom`);

    // Scroll: Scrolled down 800 pixels
    await page.aiAction(`Scroll down to bottom`);

    // Step 11: Extract data
    // console.log(
    //   `Extracting: Extract all gas stations shown in the results list with their names, addresses, and regular gas prices per gallon`
    // );
    // const extractedData11 = await page.extract({
    //   instruction: `Extract all gas stations shown in the results list with their names, addresses, and regular gas prices per gallon`,
    //   schema: z.object({
    //     gasStations: z.array(
    //       z.object({
    //         name: z.string().optional(),
    //         address: z.string().optional(),
    //         pricePerGallon: z.number().optional(),
    //       })
    //     ),
    //   }),
    // });
    // console.log("Extracted:", extractedData11);

    console.log("Workflow completed successfully");
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
