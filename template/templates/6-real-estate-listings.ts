/**
 * Template: Real Estate Listings
 * Category: Real Estate
 * Use Case: Search Zillow for properties with criteria
 * Target Site: zillow.com
 */

import "dotenv/config";
import { HyperAgent } from "../../src/agent";
import { HyperPage } from "../../src/types/agent/types";
import { z } from "zod";

// Type definitions
interface PropertySearchParams {
  location: string;
  minPrice?: string;
  maxPrice?: string;
  bedrooms?: string;
}

// Extract schema
const ZillowPropertySchema = z.object({
  properties: z.array(
    z.object({
      address: z.string().describe("Property address"),
      price: z.string().describe("Listing price"),
      bedrooms: z.string().optional().describe("Number of bedrooms"),
      bathrooms: z.string().optional().describe("Number of bathrooms"),
      sqft: z.string().optional().describe("Square footage"),
      propertyType: z
        .string()
        .optional()
        .describe("House, Condo, Townhouse, etc."),
    })
  ),
});

type ZillowPropertyResult = z.infer<typeof ZillowPropertySchema>;

/**
 * Search Zillow for properties with specified criteria
 * @param params - Property search parameters
 * @returns Promise with extracted property listings
 */
async function searchZillowProperties(
  params: PropertySearchParams
): Promise<ZillowPropertyResult> {
  let agent: any;

  try {
    // Initialize HyperAgent
    console.log("Initializing HyperAgent...");
    agent = new HyperAgent({
      llm: {
        provider: "anthropic",
        model: "claude-sonnet-4-0",
      },
      browserProvider: "Hyperbrowser",
      hyperbrowserConfig: {
        sessionConfig: {
          useProxy: true,
        },
      },
      debug: true,
    });

    // Get the page instance
    const page: HyperPage = await agent.newPage();
    if (!page) {
      throw new Error("Failed to get page instance from HyperAgent");
    }

    // Navigate to Zillow
    await page.goto("https://www.zillow.com");

    // Wait for page to load
    await page.waitForTimeout(2000);

    // Enter location
    await page.aiAction(`fill the search box with ${params.location}`);
    await page.aiAction("press Enter");

    // Wait for results
    await page.waitForTimeout(3000);

    // Apply price filters if specified
    if (params.minPrice || params.maxPrice) {
      try {
        await page.aiAction("click the Price filter");
        await page.waitForTimeout(500);

        if (params.minPrice) {
          await page.aiAction(
            `fill the minimum price field with ${params.minPrice}`
          );
        }
        if (params.maxPrice) {
          await page.aiAction(
            `fill the maximum price field with ${params.maxPrice}`
          );
        }

        await page.aiAction("click the Apply button");
        await page.waitForTimeout(1000);
      } catch (error) {
        console.warn("Could not apply price filters:", error);
      }
    }

    // Apply bedroom filter if specified
    if (params.bedrooms) {
      try {
        await page.aiAction("click the Beds & Baths filter");
        await page.waitForTimeout(500);
        await page.aiAction(
          `select ${params.bedrooms} from the bedrooms dropdown`
        );
        await page.aiAction("click the Apply button");
        await page.waitForTimeout(1000);
      } catch (error) {
        console.warn("Could not apply bedroom filter:", error);
      }
    }

    // Scroll to load more properties
    await page.aiAction("scroll to 50%");
    await page.waitForTimeout(1000);

    // Extract property listings
    const result = await page.extract(
      "Extract all property listings including address, price, bedrooms, bathrooms, square footage, and property type",
      ZillowPropertySchema
    );

    return result as ZillowPropertyResult;
  } catch (error) {
    console.error("Error in searchZillowProperties:", error);
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
  searchZillowProperties({
    location: "Seattle, WA",
    minPrice: "400000",
    maxPrice: "800000",
    bedrooms: "3",
  })
    .then((result) => {
      console.log("\n===== Zillow Property Search Results =====");
      console.log(JSON.stringify(result, null, 2));
      console.log(`\nTotal properties extracted: ${result.properties.length}`);
    })
    .catch((error) => {
      console.error("Failed:", error);
      process.exit(1);
    });
}

export { searchZillowProperties, ZillowPropertySchema };
