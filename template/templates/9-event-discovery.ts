/**
 * Template: Event Discovery & Details
 * Category: Events & Activities
 * Use Case: Search Eventbrite for events in area
 * Target Site: eventbrite.com
 */

import "dotenv/config";
import { HyperAgent } from "../../src/agent";
import { HyperPage } from "../../src/types/agent/types";
import { z } from "zod";

// Type definitions
interface EventSearchParams {
  keyword: string;
  location: string;
  date?: string;
}

// Extract schema
const EventbriteEventSchema = z.object({
  events: z.array(
    z.object({
      title: z.string().describe("Event name/title"),
      date: z.string().describe("Event date"),
      time: z.string().optional().describe("Event time"),
      location: z.string().describe("Event venue/location"),
      price: z.string().optional().describe('Ticket price or "Free"'),
      organizer: z.string().optional().describe("Event organizer name"),
    })
  ),
});

type EventbriteEventResult = z.infer<typeof EventbriteEventSchema>;

/**
 * Search Eventbrite for events matching criteria
 * @param params - Event search parameters
 * @returns Promise with extracted event listings
 */
async function searchEventbriteEvents(
  params: EventSearchParams
): Promise<EventbriteEventResult> {
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

    // Navigate to Eventbrite
    await page.goto("https://www.eventbrite.com");

    // Wait for page to load
    await page.waitForTimeout(2000);

    // Search for events
    await page.aiAction(
      `fill the search for events field with ${params.keyword}`
    );
    await page.aiAction(`fill the location field with ${params.location}`);
    await page.aiAction("click the Search button");

    // Wait for results
    await page.waitForTimeout(3000);

    // Apply date filter if specified
    if (params.date) {
      try {
        await page.aiAction("click the Date filter");
        await page.waitForTimeout(500);
        await page.aiAction(`select ${params.date} from the date options`);
        await page.waitForTimeout(1000);
      } catch (error) {
        console.warn("Could not apply date filter:", error);
      }
    }

    // Scroll to load more events
    await page.aiAction("scroll down one page");
    await page.waitForTimeout(1000);

    // Extract event listings
    const result = await page.extract(
      "Extract all event listings including title, date, time, location, price, and organizer",
      EventbriteEventSchema
    );

    return result as EventbriteEventResult;
  } catch (error) {
    console.error("Error in searchEventbriteEvents:", error);
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
  searchEventbriteEvents({
    keyword: "tech conference",
    location: "New York, NY",
    date: "This weekend",
  })
    .then((result) => {
      console.log("\n===== Eventbrite Search Results =====");
      console.log(JSON.stringify(result, null, 2));
      console.log(`\nTotal events extracted: ${result.events.length}`);
    })
    .catch((error) => {
      console.error("Failed:", error);
      process.exit(1);
    });
}

export { searchEventbriteEvents, EventbriteEventSchema };
