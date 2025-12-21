/**
 * Template: News Aggregation
 * Category: News & Content Aggregation
 * Use Case: Scroll through news site and extract article headlines
 * Target Site: news.ycombinator.com
 */

import "dotenv/config";
import { HyperAgent } from "../../src/agent";
import { HyperPage } from "../../src/types/agent/types";
import { z } from "zod";

// Extract schema
const HackerNewsSchema = z.object({
  stories: z.array(
    z.object({
      title: z.string().describe("Story headline"),
      url: z.string().optional().describe("Link to article"),
      points: z.string().optional().describe("Upvote count"),
      author: z.string().optional().describe("Username who posted"),
      commentCount: z.string().optional().describe("Number of comments"),
    })
  ),
});

type HackerNewsResult = z.infer<typeof HackerNewsSchema>;

/**
 * Extract stories from Hacker News front page
 * @returns Promise with extracted story data
 */
async function extractHackerNewsStories(): Promise<HackerNewsResult> {
  let agent: HyperAgent | null = null;

  try {
    // Initialize HyperAgent
    console.log("Initializing HyperAgent...");
    agent = new HyperAgent({
    llm: {
        provider: "anthropic",
        model: "claude-sonnet-4-0",
      },
      headless: false,
    debug: true,
    });

    // Get the page instance
    const page: HyperPage = await agent.newPage();
    if (!page) {
      throw new Error("Failed to get page instance from HyperAgent");
    }

    // Navigate to Hacker News
    await page.goto("https://news.ycombinator.com");

    // Wait for page to load
    await page.waitForTimeout(2000);

    // Scroll to load more stories
    await page.aiAction("scroll to 50%");
    await page.waitForTimeout(1000);

    // Extract stories
    const result = await page.extract(
      "Extract all story listings including title, URL, points, author, and comment count",
      HackerNewsSchema
    );

    return result as HackerNewsResult;
  } catch (error) {
    console.error("Error in extractHackerNewsStories:", error);
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
  extractHackerNewsStories()
    .then((result) => {
      console.log("\n===== Hacker News Stories =====");
      console.log(JSON.stringify(result, null, 2));
      console.log(`\nTotal stories extracted: ${result.stories.length}`);
    })
    .catch((error) => {
      console.error("Failed:", error);
      process.exit(1);
    });
}

export { extractHackerNewsStories, HackerNewsSchema };
