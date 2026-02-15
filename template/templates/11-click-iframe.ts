/**
 * Template: Iframe Interaction
 * Category: Advanced DOM Interaction
 * Use Case: Interact with elements inside iframes (single and nested)
 * Target Site: demo.automationtesting.in/Frames.html
 */

import "dotenv/config";
import { HyperAgent } from "../../src/agent";
import { HyperPage } from "../../src/types/agent/types";
import { z } from "zod";

// Type definitions
interface IframeTestParams {
  scenario: "single" | "nested";
  testData?: {
    name?: string;
    email?: string;
  };
  debug?: true;
}

// Extract schema
const IframeInteractionSchema = z.object({
  scenario: z.string().describe("Which iframe scenario was tested"),
  elementsFound: z
    .array(z.string())
    .describe("List of interactive elements found in the iframe"),
  interactionSuccess: z
    .boolean()
    .describe("Whether the iframe interaction was successful"),
  message: z
    .string()
    .describe("Description of what happened during the interaction"),
});

type IframeInteractionResult = z.infer<typeof IframeInteractionSchema>;

/**
 * Test iframe interaction on demo automation site
 * @param params - Test parameters including scenario type
 * @returns Promise with interaction results
 */
async function testIframeInteraction(params: IframeTestParams) {
  let agent: HyperAgent<any> | null = null;

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
      // browserProvider: "Hyperbrowser",
    });

    // Get the page instance
    const page: HyperPage = await agent.newPage();
    if (!page) {
      throw new Error("Failed to get page instance from HyperAgent");
    }

    // Navigate to iframe demo page
    console.log("Navigating to iframe demo page...");
    await page.goto("https://demo.automationtesting.in/Frames.html");

    // Wait for page to load
    await page.waitForTimeout(2000);

    if (params.scenario === "single") {
      console.log("Testing single iframe scenario...");

      // Click the "Single Iframe" tab
      await page.aiAction('click the "Single Iframe" tab');
      await page.waitForTimeout(1000);

      // Interact with iframe content
      // HyperAgent automatically detects elements inside iframes - no special syntax needed
      const testName = params.testData?.name || "Test User";
      await page.aiAction(`type "${testName}" in the input field`);
      await page.waitForTimeout(500);

      console.log(`Successfully typed "${testName}" in iframe input field`);
    } else if (params.scenario === "nested") {
      console.log("Testing nested iframe scenario...");

      // Click the "Iframe with in an Iframe" tab
      await page.aiAction('click the "Iframe with in an Iframe" tab');

      // Wait for the nested iframe structure to load
      // The nested iframe contains another iframe with SingleFrame.html
      // await page.waitForTimeout(2000);

      // Wait for frame with SingleFrame.html to be available
      // const frames = page.frames();
      // console.log(
      //   `Waiting for frames to load... Found ${frames.length} frames`
      // );

      // // Wait for frames to load their content
      // await Promise.all(
      //   frames.map(async (frame) => {
      //     if (frame.url().includes("SingleFrame.html")) {
      //       try {
      //         await frame.waitForLoadState("domcontentloaded", {
      //           timeout: 5000,
      //         });
      //         console.log(`Frame loaded: ${frame.url()}`);
      //       } catch (e) {
      //         console.log(`Frame load timeout: ${frame.url()}`);
      //       }
      //     }
      //   })
      // );

      // Additional wait for accessibility tree to update
      // await page.waitForTimeout(1000);

      // Interact with nested iframe content
      // HyperAgent traverses all iframe levels automatically
      const testName = params.testData?.name || "Nested Test User";
      await page.aiAction(`click the input field in the nested iframe`);
      await page.aiAction(
        `type "${testName}" in the input field in the nested iframe`
      );
      await page.waitForTimeout(500);

      console.log(
        `Successfully typed "${testName}" in nested iframe input field`
      );
    }

    // Extract verification data
    // const result = await page.extract(
    //   "Verify the iframe interaction was successful. List any interactive elements you found in the iframe(s) and confirm if the interactions worked properly.",
    //   IframeInteractionSchema
    // );

    // return result as IframeInteractionResult;
  } catch (error) {
    console.error("Error in testIframeInteraction:", error);
    throw error;
  } finally {
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

// Example usage
if (require.main === module) {
  // Test single iframe scenario
  // testIframeInteraction({
  //   scenario: "single",
  //   testData: {
  //     name: "John Doe",
  //     email: "john@example.com",
  //   },
  // });

  // Test nested iframe scenario:
  testIframeInteraction({
    scenario: "nested",
    testData: { name: "Jane Smith" },
  });
}

export { testIframeInteraction, IframeInteractionSchema };
