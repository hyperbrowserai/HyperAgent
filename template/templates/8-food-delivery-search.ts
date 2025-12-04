/**
 * Template: Restaurant/Food Delivery Search
 * Category: Food & Dining
 * Use Case: Search DoorDash for restaurants in area
 * Target Site: doordash.com
 */

import "dotenv/config";
import { HyperAgent } from "../../src/agent";
import { HyperPage } from "../../src/types/agent/types";
import { z } from "zod";

// Type definitions
interface RestaurantSearchParams {
  location: string;
  cuisine?: string;
}

// Extract schema
const DoorDashRestaurantSchema = z.object({
  restaurants: z.array(
    z.object({
      name: z.string().describe("Restaurant name"),
      rating: z.string().optional().describe('Customer rating (e.g., "4.5")'),
      deliveryTime: z.string().optional().describe("Estimated delivery time"),
      deliveryFee: z.string().optional().describe("Delivery fee amount"),
      cuisine: z.string().optional().describe("Type of cuisine"),
    })
  ),
});

type DoorDashRestaurantResult = z.infer<typeof DoorDashRestaurantSchema>;

/**
 * Search DoorDash for restaurants in specified location
 * @param params - Search parameters including location and optional cuisine
 * @returns Promise with extracted restaurant listings
 */
async function searchDoorDashRestaurants(
  params: RestaurantSearchParams
): Promise<DoorDashRestaurantResult> {
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

    // Navigate to DoorDash
    await page.goto("https://www.doordash.com");

    // Wait for page to load
    await page.waitForTimeout(2000);

    // Enter delivery address
    await page.aiAction(`fill the address field with ${params.location}`);
    await page.aiAction("press Enter");

    // Wait for restaurants to load
    await page.waitForTimeout(3000);

    // Filter by cuisine if specified
    if (params.cuisine) {
      try {
        await page.aiAction(
          `fill the search for restaurants field with ${params.cuisine}`
        );
        await page.waitForTimeout(1500);
      } catch (error) {
        console.warn("Could not apply cuisine filter:", error);
      }
    }

    // Scroll to see more restaurants
    await page.aiAction("scroll to 50%");
    await page.waitForTimeout(1000);

    // Extract restaurant listings
    const result = await page.extract(
      "Extract all restaurant listings including name, rating, delivery time, delivery fee, and cuisine type",
      DoorDashRestaurantSchema
    );

    return result as DoorDashRestaurantResult;
  } catch (error) {
    console.error("Error in searchDoorDashRestaurants:", error);
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
  searchDoorDashRestaurants({
    location: "San Francisco, CA",
    cuisine: "Italian",
  })
    .then((result) => {
      console.log("\n===== DoorDash Restaurant Search Results =====");
      console.log(JSON.stringify(result, null, 2));
      console.log(
        `\nTotal restaurants extracted: ${result.restaurants.length}`
      );
    })
    .catch((error) => {
      console.error("Failed:", error);
      process.exit(1);
    });
}

export { searchDoorDashRestaurants, DoorDashRestaurantSchema };
