/**
 * Template: Social Media Feed Extraction
 * Category: Social Media Data Collection
 * Use Case: Extract posts from Twitter/X user feed
 * Target Site: x.com
 */

import "dotenv/config";
import { HyperAgent } from "../../src/agent";
import { HyperPage } from "../../src/types/agent/types";
import { z } from "zod";

// Extract schema
const TwitterFeedSchema = z.object({
  posts: z.array(
    z.object({
      author: z.string().describe("Username or display name"),
      content: z.string().describe("Tweet text content"),
      timestamp: z.string().optional().describe("Relative or absolute time"),
      likes: z.string().optional().describe("Like count"),
      retweets: z.string().optional().describe("Retweet count"),
    })
  ),
});

type TwitterFeedResult = z.infer<typeof TwitterFeedSchema>;

/**
 * Extract posts from Twitter/X feed
 * @returns Promise with extracted feed data
 */
async function extractTwitterFeed(): Promise<TwitterFeedResult> {
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
    });

    // Get the page instance
    const page: HyperPage = await agent.newPage();
    if (!page) {
      throw new Error("Failed to get page instance from HyperAgent");
    }

    // Navigate to Twitter
    await page.goto("https://x.com");

    // Wait for page to load
    await page.waitForTimeout(2000);

    // Click on timeline/feed (or just scroll if already on timeline)
    await page.aiAction("scroll to 30%");
    await page.waitForTimeout(1000); // Allow lazy load

    // Scroll to load more posts
    await page.aiAction("scroll to 50%");
    await page.waitForTimeout(1000); // Allow lazy load

    // Extract posts
    const result = await page.extract(
      "Extract all visible tweets/posts including author, content, timestamp, likes, and retweets",
      TwitterFeedSchema
    );

    return result as TwitterFeedResult;
  } catch (error) {
    console.error("Error in extractTwitterFeed:", error);
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
  extractTwitterFeed()
    .then((result) => {
      console.log("\n===== Twitter Feed Results =====");
      console.log(JSON.stringify(result, null, 2));
      console.log(`\nTotal posts extracted: ${result.posts.length}`);
    })
    .catch((error) => {
      console.error("Failed:", error);
      process.exit(1);
    });
}

export { extractTwitterFeed, TwitterFeedSchema };
