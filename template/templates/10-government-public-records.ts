/**
 * Template: Government/Public Records
 * Category: Government & Public Data
 * Use Case: Navigate gov site and extract public information
 * Target Site: usa.gov
 */

import "dotenv/config";
import { HyperAgent } from "../../src/agent";
import { HyperPage } from "../../src/types/agent/types";
import { z } from "zod";

// Type definitions
interface GovSearchParams {
  query: string;
}

// Extract schema
const GovSearchResultSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().describe("Result title/heading"),
      description: z.string().optional().describe("Brief description"),
      url: z.string().optional().describe("Link to resource"),
      agency: z.string().optional().describe("Government agency responsible"),
    })
  ),
});

type GovSearchResult = z.infer<typeof GovSearchResultSchema>;

/**
 * Search USA.gov for government services and information
 * @param params - Search parameters including query string
 * @returns Promise with extracted search results
 */
async function searchGovernmentServices(
  params: GovSearchParams
): Promise<GovSearchResult> {
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

    // Navigate to USA.gov
    await page.goto("https://www.usa.gov");

    // Wait for page to load
    await page.waitForTimeout(2000);

    // Search for government service
    await page.aiAction(`fill the search box with ${params.query}`);
    await page.aiAction("press Enter");

    // Wait for results
    await page.waitForTimeout(3000);

    // Scroll to see more results
    await page.aiAction("scroll to 50%");
    await page.waitForTimeout(1000);

    // Extract search results
    const result = await page.extract(
      "Extract all search results including title, description, URL, and government agency",
      GovSearchResultSchema
    );

    return result as GovSearchResult;
  } catch (error) {
    console.error("Error in searchGovernmentServices:", error);
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
  searchGovernmentServices({
    query: "passport application",
  })
    .then((result) => {
      console.log("\n===== Government Service Search Results =====");
      console.log(JSON.stringify(result, null, 2));
      console.log(`\nTotal results extracted: ${result.results.length}`);
    })
    .catch((error) => {
      console.error("Failed:", error);
      process.exit(1);
    });
}

export { searchGovernmentServices, GovSearchResultSchema };
