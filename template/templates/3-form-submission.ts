/**
 * Template: Form Submission & Validation
 * Category: Form Submission
 * Use Case: Fill out a multi-field contact form
 * Target Site: Generic contact form (e.g., TypeForm, Google Forms)
 */

import "dotenv/config";
import { HyperAgent } from "../../src/agent";
import { HyperPage } from "../../src/types/agent/types";
import { z } from "zod";

// Type definitions
interface FormData {
  name: string;
  email: string;
  phone?: string;
  subject: string;
  message: string;
  subscribe?: boolean;
}

// Extract schema for confirmation
const FormConfirmationSchema = z.object({
  success: z.boolean().describe("Whether form was submitted successfully"),
  message: z.string().describe("Confirmation or error message"),
});

type FormConfirmationResult = z.infer<typeof FormConfirmationSchema>;

/**
 * Submit a contact form with provided data
 * @param formUrl - URL of the form to fill out
 * @param data - Form data to submit
 * @returns Promise with confirmation result
 */
async function submitContactForm(
  formUrl: string,
  data: FormData
): Promise<FormConfirmationResult> {
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

    // Navigate to form
    await page.goto(formUrl);

    // Wait for form to load
    await page.waitForTimeout(2000);

    // Fill form fields
    await page.aiAction(`fill the name field with ${data.name}`);
    await page.aiAction(`fill the email field with ${data.email}`);

    if (data.phone) {
      await page.aiAction(`fill the phone field with ${data.phone}`);
    }

    await page.aiAction(`fill the subject field with ${data.subject}`);
    await page.aiAction(`fill the message field with ${data.message}`);

    // Handle optional checkbox
    if (data.subscribe) {
      await page.aiAction("check the newsletter subscription checkbox");
    }

    // Submit form
    await page.aiAction("click the Submit button");

    // Wait for confirmation
    await page.waitForTimeout(2000);

    // Extract confirmation message
    const result = await page.extract(
      "Extract the success/confirmation message or error message after form submission, and determine if submission was successful",
      FormConfirmationSchema
    );

    return result as FormConfirmationResult;
  } catch (error) {
    console.error("Error in submitContactForm:", error);
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
  // Replace with actual form URL for testing
  const testFormUrl = "https://example.com/contact";

  submitContactForm(testFormUrl, {
    name: "John Doe",
    email: "john.doe@example.com",
    phone: "555-123-4567",
    subject: "Test Inquiry",
    message: "This is a test message from the form automation template.",
    subscribe: true,
  })
    .then((result) => {
      console.log("\n===== Form Submission Results =====");
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error("Failed:", error);
      process.exit(1);
    });
}

export { submitContactForm, FormConfirmationSchema };
