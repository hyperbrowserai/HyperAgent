// workflow.ts

import { HyperPage } from "../src/types/agent/types";
import { HyperAgent } from "../src/agent";
import { z } from "zod";

// Install all dependencies:
// pnpm add -D playwright tsx typescript @types/node
//
// Then install the browser binary:
// pnpm exec playwright install chromium

// Generated script for workflow 49bc9db5-e0c5-4fd1-9956-c64b68db69de
// Generated at 2025-10-27T23:39:52.578Z

async function runWorkflow() {
  let agent: HyperAgent | null = null;

  try {
    // Initialize HyperAgent
    console.log("Initializing HyperAgent...");
    agent = new HyperAgent({
      llm: {
        provider: "openai",
        model: "gpt-4o",
      },
      debug: true,
    });

    // Get the page instance
    const page: HyperPage = await agent.newPage();
    if (!page) {
      throw new Error("Failed to get page instance from HyperAgent");
    }

    // Step 1: Navigate to URL
    console.log("Navigating to: https://www.marriott.com/");
    await page.goto("https://www.marriott.com/");

    // Step 2: Perform action
    console.log(`Performing action: click the Sign In or Join button`);
    await page.aiAction(`click the Sign In or Join button`);

    // Step 3: Perform action
    console.log(`Performing action: click the Trips (1) link`);
    await page.aiAction(`click the Trips (1) link`);

    // Step 4: Perform action
    console.log(`Performing action: click the View/Modify Room link`);
    await page.aiAction(`click the View/Modify Room link`);

    // Step 5: Perform action
    console.log(
      `Performing action: click the Summary of Charges 344.85 USD Total button`
    );
    await page.aiAction(`click the Summary of Charges 344.85 USD Total button`);

    // Scroll: Scrolled down 300 pixels
    await page.aiAction(`Scrolled down 300 pixels`);

    // Scroll: Scrolled up 500 pixels
    await page.aiAction(`Scrolled up 500 pixels`);

    // Scroll: Scrolled up 300 pixels
    await page.aiAction(`Scrolled up 300 pixels`);

    // Step 9: Perform action
    console.log(`Performing action: click the Print button`);
    await page.aiAction(`click the Print button`);

    // Step 10: Extract data
    console.log(
      `Extracting: Extract the complete itemized receipt information including hotel details, guest information, reservation details, and all itemized charges with amounts`
    );
    const extractedData10 = await page.extract(
      `Extract the complete itemized receipt information including hotel details, guest information, reservation details, and all itemized charges with amounts`,
      z.object({
        hotelName: z.string().optional(),
        hotelAddress: z.string().optional(),
        hotelPhone: z.string().optional(),
        guestName: z.string().optional(),
        confirmationNumber: z.string().optional(),
        checkInDate: z.string().optional(),
        checkOutDate: z.string().optional(),
        roomType: z.string().optional(),
        numberOfGuests: z.string().optional(),
        rateType: z.string().optional(),
        itemizedCharges: z
          .array(
            z.object({
              description: z.string().optional(),
              amount: z.number().optional(),
            })
          )
          .optional(),
        totalAmount: z.number().optional(),
      })
    );
    console.log("Extracted:", extractedData10);

    // Scroll: Scrolled down 400 pixels
    await page.aiAction(`Scrolled down 400 pixels`);

    // Scroll: Scrolled down 300 pixels
    await page.aiAction(`Scrolled down 300 pixels`);

    // Scroll: Scrolled down 200 pixels
    await page.aiAction(`Scrolled down 200 pixels`);

    // Scroll: Scrolled up 800 pixels
    await page.aiAction(`Scrolled up 800 pixels`);

    // Scroll: Scrolled up 200 pixels
    await page.aiAction(`Scrolled up 200 pixels`);

    // Step 16: Extract data
    console.log(
      `Extracting: Extract all available data from this hotel receipt/reservation including hotel details, guest information, dates, room details, all charges and fees, payment information, policies, and any additional information visible on the page`
    );
    // const extractedData16 = await page.extract(
    //   `Extract all available data from this hotel receipt/reservation including hotel details, guest information, dates, room details, all charges and fees, payment information, policies, and any additional information visible on the page`,
    //   z.object({
    //     hotelName: z.string().optional(),
    //     hotelBrand: z.string().optional(),
    //     hotelAddress: z.string().optional(),
    //     hotelCity: z.string().optional(),
    //     hotelState: z.string().optional(),
    //     hotelZipCode: z.string().optional(),
    //     hotelCountry: z.string().optional(),
    //     hotelPhone: z.string().optional(),
    //     hotelRating: z.string().optional(),
    //     hotelReviewCount: z.string().optional(),
    //     guestName: z.string().optional(),
    //     guestFirstName: z.string().optional(),
    //     guestLastName: z.string().optional(),
    //     confirmationNumber: z.string().optional(),
    //     reservationStatus: z.string().optional(),
    //     checkInDate: z.string().optional(),
    //     checkOutDate: z.string().optional(),
    //     numberOfNights: z.number().optional(),
    //     roomType: z.string().optional(),
    //     numberOfGuests: z.number().optional(),
    //     numberOfAdults: z.number().optional(),
    //     numberOfChildren: z.number().optional(),
    //     rateType: z.string().optional(),
    //     ratePlan: z.string().optional(),
    //     roomRate: z.number().optional(),
    //     roomRateCurrency: z.string().optional(),
    //     governmentTaxes: z.number().optional(),
    //     tourismFee: z.number().optional(),
    //     conventionFee: z.number().optional(),
    //     subtotal: z.number().optional(),
    //     totalAmount: z.number().optional(),
    //     totalCurrency: z.string().optional(),
    //     paymentMethod: z.string().optional(),
    //     cardType: z.string().optional(),
    //     cardLastFourDigits: z.string().optional(),
    //     cancellationDeadline: z.string().optional(),
    //     cancellationPolicy: z.string().optional(),
    //     earlyDeparturePolicy: z.string().optional(),
    //     parkingFeeCompact: z.number().optional(),
    //     parkingFeeLarge: z.number().optional(),
    //     garageHeightLimit: z.string().optional(),
    //     parkingRetrievalTime: z.string().optional(),
    //     upgradeAvailable: z.string().optional(),
    //     upgradePrice: z.number().optional(),
    //     specialNotes: z.string().optional(),
    //     bookingDate: z.string().optional(),
    //     loyaltyProgram: z.string().optional(),
    //     memberNumber: z.string().optional(),
    //   })
    // );
    // console.log("Extracted:", extractedData16);

    console.log("Workflow completed successfully");
    return { success: true };
  } catch (error) {
    console.error("Workflow failed:", error);
    return { success: false, error };
  } finally {
    // Clean up
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

// Single execution
runWorkflow().then((result) => {
  console.log("Execution result:", result);
  process.exit(result.success ? 0 : 1);
});

export default runWorkflow;
