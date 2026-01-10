/**
 * Template: YouTube OOPIF (Out-of-Process IFrame)
 * Category: Advanced Cross-Origin Iframe
 * Use Case: Interact with cross-origin embedded content (YouTube player)
 * Target Site: visualidentity.columbia.edu/content/video-embed
 */

import "dotenv/config";
import { HyperAgent } from "../../src/agent";
import { HyperPage } from "../../src/types/agent/types";
import { z } from "zod";

// Type definitions
interface YouTubeOOPIFParams {
  action: "play" | "pause" | "inspect";
  debug?: true;
}

// Extract schema
const YouTubeOOPIFSchema = z.object({
  oopifDetected: z
    .boolean()
    .describe("Whether cross-origin iframe (OOPIF) was detected"),
  frameCount: z
    .number()
    .describe("Total number of frames detected on the page"),
  youtubeFrameFound: z
    .boolean()
    .describe("Whether the YouTube iframe was found"),
  actionSuccess: z
    .boolean()
    .describe("Whether the interaction with YouTube player was successful"),
  elementsFound: z
    .array(z.string())
    .describe("List of interactive elements found in the YouTube iframe"),
  message: z
    .string()
    .describe("Description of what happened during the interaction"),
});

// type YouTubeOOPIFResult = z.infer<typeof YouTubeOOPIFSchema>;

/**
 * Test OOPIF interaction with YouTube embedded video
 * @param params - Test parameters including action type
 * @returns Promise with interaction results
 */
async function testYouTubeOOPIF(params: YouTubeOOPIFParams): Promise<void> {
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
    });

    // Get the page instance
    const page: HyperPage = await agent.newPage();
    if (!page) {
      throw new Error("Failed to get page instance from HyperAgent");
    }

    // Navigate to Columbia video embed page
    console.log("Navigating to Columbia video embed page...");
    await page.goto("https://visualidentity.columbia.edu/content/video-embed");

    // Wait for page to load
    await page.waitForTimeout(3000);

    console.log("Page loaded, detecting frames...");

    // Get frame information for debugging
    const frames = page.frames();
    console.log(`Total frames detected: ${frames.length}`);

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const url = frame.url();
      console.log(
        `Frame ${i}: ${url.substring(0, 100)}${url.length > 100 ? "..." : ""}`
      );
    }

    await page.aiAction("scroll to youtube video");

    // Perform action based on params
    if (params.action === "play") {
      console.log("Attempting to play YouTube video...");

      // HyperAgent should automatically detect elements in OOPIF (cross-origin iframe)
      // The YouTube player is embedded from youtube.com domain
      await page.aiAction("click the play button in the YouTube video iframe");

      await page.waitForTimeout(2000);
      console.log("Play button clicked");
    } else if (params.action === "pause") {
      console.log("Attempting to pause YouTube video...");

      await page.aiAction("click the play button on the YouTube video");
      await page.waitForTimeout(1000);
      await page.aiAction("click the pause button on the YouTube video");

      console.log("Video paused");
    } else if (params.action === "inspect") {
      console.log("Inspecting YouTube iframe elements...");
      // Just inspect, no action
    }

    // Extract verification data
    await new Promise((resolve) => setTimeout(resolve, 5000));
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
  testYouTubeOOPIF({
    action: "play",
  });

  // Test inspect action:
  // testYouTubeOOPIF({
  //   action: "inspect",
  // });
}

export { testYouTubeOOPIF, YouTubeOOPIFSchema };
