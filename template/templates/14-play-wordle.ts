import "dotenv/config";
import { HyperAgent } from "../../src/agent";
import { HyperPage } from "../../src/types/agent/types";

/**
 * Test OOPIF interaction with YouTube embedded video
 * @param params - Test parameters including action type
 * @returns Promise with interaction results
 */
async function testPlayWordle(): Promise<void> {
  let agent: HyperAgent<any> | null = null;

  try {
    // Initialize HyperAgent
    console.log("Initializing HyperAgent...");
    agent = new HyperAgent({
      // llm: {
      //   provider: "openai",
      //   model: "gpt-5-mini",
      // },
      llm: {
        provider: "anthropic",
        model: "claude-sonnet-4-0",
      },
      debug: true,
      cdpActions: true,
    });

    // Get the page instance
    const page: HyperPage = await agent.newPage();
    if (!page) {
      throw new Error("Failed to get page instance from HyperAgent");
    }

    // Navigate to Columbia video embed page
    console.log("Navigating to wordle.");
    await page.goto("https://www.nytimes.com/games/wordle/index.html");

    await page.ai("Learn how to play wordle and try to win.");
  } catch (error) {
    console.error("Error in testYouTubeOOPIF:", error);
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
  // Test play action
  testPlayWordle();

  // Test inspect action:
  // testYouTubeOOPIF({
  //   action: "inspect",
  // });
}
