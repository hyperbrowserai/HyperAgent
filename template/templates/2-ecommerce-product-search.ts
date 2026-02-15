/**
 * Template: E-commerce Product Search
 * Category: E-commerce Product Search
 * Use Case: Search Amazon for products and extract details
 * Target Site: amazon.com
 */

import "dotenv/config";
import { HyperAgent } from "../../src/agent";
import { HyperPage } from "../../src/types/agent/types";
import { z } from "zod";

// Type definitions
interface ProductSearchParams {
  searchQuery: string;
}

// Extract schema
const AmazonProductSchema = z.object({
  products: z.array(
    z.object({
      title: z.string().describe("Product name/title"),
      price: z.string().optional().describe('Price as string (e.g., "$29.99")'),
      rating: z.string().optional().describe('Star rating (e.g., "4.5")'),
      reviewCount: z.string().optional().describe("Number of reviews"),
      prime: z.boolean().optional().describe("Amazon Prime eligible"),
    })
  ),
});

type AmazonProductResult = z.infer<typeof AmazonProductSchema>;

/**
 * Search Amazon for products and extract details
 * @param params - Search parameters including query string
 * @returns Promise with extracted product data
 */
async function searchAmazonProducts(
  params: ProductSearchParams
): Promise<AmazonProductResult> {
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

    // Navigate to Amazon
    await page.goto("https://www.amazon.com");

    // Wait for page to load
    await page.waitForTimeout(2000);

    // Search for product
    await page.aiAction(`fill the search box with ${params.searchQuery}`);
    await page.aiAction("press Enter");

    // Wait for results to load
    await page.waitForTimeout(2000);

    // Scroll to see more products
    await page.aiAction("scroll to 50%");
    await page.waitForTimeout(1000);

    // Extract product details
    const result = await page.extract(
      "Extract all product listings including title, price, rating, review count, and whether Prime eligible",
      AmazonProductSchema
    );

    return result as AmazonProductResult;
  } catch (error) {
    console.error("Error in searchAmazonProducts:", error);
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
  searchAmazonProducts({
    searchQuery: "wireless headphones",
  })
    .then((result) => {
      console.log("\n===== Amazon Product Search Results =====");
      console.log(JSON.stringify(result, null, 2));
      console.log(`\nTotal products extracted: ${result.products.length}`);
    })
    .catch((error) => {
      console.error("Failed:", error);
      process.exit(1);
    });
}

export { searchAmazonProducts, AmazonProductSchema };
