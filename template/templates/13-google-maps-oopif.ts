/**
 * Template: Google Maps OOPIF (Out-of-Process IFrame)
 * Category: Advanced Cross-Origin Iframe
 * Use Case: Interact with cross-origin embedded Google Maps
 * Target Site: developers.google.com/maps/documentation/embed/embedding-map
 */

import "dotenv/config";
import { HyperAgent } from "../../src/agent";
import { HyperPage } from "../../src/types/agent/types";
import { z } from "zod";

// Type definitions
interface GoogleMapsOOPIFParams {
  debug?: true;
}

// Extract schema
const GoogleMapsOOPIFSchema = z.object({
  oopifDetected: z
    .boolean()
    .describe("Whether cross-origin iframe (OOPIF) was detected"),
  frameCount: z
    .number()
    .describe("Total number of frames detected on the page"),
  mapsFrameFound: z
    .boolean()
    .describe("Whether the Google Maps iframe was found"),
  actionsCompleted: z
    .array(z.string())
    .describe("List of actions that were successfully completed"),
  elementsFound: z
    .array(z.string())
    .describe("List of interactive elements found in the Google Maps iframe"),
  message: z
    .string()
    .describe("Description of what happened during the interactions"),
});

type GoogleMapsOOPIFResult = z.infer<typeof GoogleMapsOOPIFSchema>;

/**
 * Test OOPIF interaction with Google Maps embedded iframe
 * @param params - Test parameters
 * @returns Promise with interaction results
 */
async function testGoogleMapsOOPIF(
  params: GoogleMapsOOPIFParams
): Promise<GoogleMapsOOPIFResult> {
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

    // Navigate to Google Maps embedding documentation page
    console.log("Navigating to Google Maps documentation page...");
    await page.goto(
      "https://developers.google.com/maps/documentation/embed/embedding-map"
    );

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

    // Step 1: Scroll to the map
    console.log("\n=== Step 1: Scrolling to map ===");
    await page.aiAction("scroll to first map");
    await page.waitForTimeout(1500);
    console.log("✓ Scrolled to map");

    // Step 2: Click expand map controls
    console.log("\n=== Step 2: Expanding map controls ===");
    await page.aiAction("click the Map camera controls");
    await page.waitForTimeout(1500);
    console.log("✓ Expanded map controls");

    // Step 3: Click move up button
    console.log("\n=== Step 3: Moving map up ===");
    await page.aiAction("click the move up button camera control");
    await page.waitForTimeout(1500);
    console.log("✓ Moved map up");

    // Step 4: Click move right button
    console.log("\n=== Step 4: Moving map right ===");
    await page.aiAction("click the move right button camera control");
    await page.waitForTimeout(1500);
    console.log("✓ Moved map right");

    console.log("\n=== All steps completed ===");

    // Extract verification data
    const result = await page.extract(
      `Verify the Google Maps OOPIF (cross-origin iframe) interactions.
       Check if:
       1. The Google Maps iframe was detected (it's from google.com domain, different from the main page)
       2. All four actions were completed successfully:
          - Scrolled to map
          - Expanded map controls
          - Moved map up
          - Moved map right
       3. List all interactive elements you found in the Google Maps iframe.`,
      GoogleMapsOOPIFSchema
    );

    return result as GoogleMapsOOPIFResult;
  } catch (error) {
    console.error("Error in testGoogleMapsOOPIF:", error);
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
  testGoogleMapsOOPIF({});
}

export { testGoogleMapsOOPIF, GoogleMapsOOPIFSchema };
