/**
 * Template: Job Board Search & Filter
 * Category: Job Search
 * Use Case: Search LinkedIn Jobs with filters and extract listings
 * Target Site: linkedin.com/jobs
 */

import "dotenv/config";
import { HyperAgent } from "../../src/agent";
import { HyperPage } from "../../src/types/agent/types";
import { z } from "zod";

// Type definitions
interface JobSearchParams {
  keyword: string;
  location: string;
  jobType?: "Full-time" | "Part-time" | "Contract";
}

// Extract schema
const LinkedInJobSchema = z.object({
  jobs: z.array(
    z.object({
      title: z.string().describe("Job title"),
      company: z.string().describe("Company name"),
      location: z.string().describe("Job location"),
      postedDate: z
        .string()
        .optional()
        .describe('When posted (e.g., "2 days ago")'),
      salary: z.string().optional().describe("Salary range if listed"),
    })
  ),
});

type LinkedInJobResult = z.infer<typeof LinkedInJobSchema>;

/**
 * Search LinkedIn Jobs with filters and extract listings
 * @param params - Job search parameters
 * @returns Promise with extracted job listings
 */
async function searchLinkedInJobs(
  params: JobSearchParams
): Promise<LinkedInJobResult> {
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

    // Navigate to LinkedIn Jobs
    await page.goto("https://www.linkedin.com/jobs");

    // Wait for page to load
    await page.waitForTimeout(2000);

    // Fill search fields
    await page.aiAction(
      `fill the job title search box with ${params.keyword}`
    );
    await page.aiAction(
      `fill the location search box with ${params.location}`
    );

    // Click search
    await page.aiAction("click the Search button");

    // Wait for results
    await page.waitForTimeout(3000);

    // Apply job type filter if specified
    if (params.jobType) {
      try {
        await page.aiAction("click the Job Type filter");
        await page.waitForTimeout(500);
        await page.aiAction(`check the ${params.jobType} checkbox`);
        await page.aiAction("click the Apply filters button");
        await page.waitForTimeout(1000);
      } catch (error) {
        console.warn("Could not apply job type filter:", error);
      }
    }

    // Scroll to load more jobs
    await page.aiAction("scroll to 50%");
    await page.waitForTimeout(1000);

    // Extract job listings
    const result = await page.extract(
      "Extract all job listings including title, company, location, posted date, and salary if available",
      LinkedInJobSchema
    );

    return result as LinkedInJobResult;
  } catch (error) {
    console.error("Error in searchLinkedInJobs:", error);
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
  searchLinkedInJobs({
    keyword: "Software Engineer",
    location: "San Francisco, CA",
    jobType: "Full-time",
  })
    .then((result) => {
      console.log("\n===== LinkedIn Job Search Results =====");
      console.log(JSON.stringify(result, null, 2));
      console.log(`\nTotal jobs extracted: ${result.jobs.length}`);
    })
    .catch((error) => {
      console.error("Failed:", error);
      process.exit(1);
    });
}

export { searchLinkedInJobs, LinkedInJobSchema };
