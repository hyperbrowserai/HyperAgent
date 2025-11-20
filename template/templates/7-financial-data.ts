/**
 * Template: Financial Data Collection
 * Category: Financial Data
 * Use Case: Extract stock quotes and crypto prices
 * Target Site: finance.yahoo.com
 */

import "dotenv/config";
import { HyperAgent } from "../../src/agent";
import { HyperPage } from "../../src/types/agent/types";
import { z } from "zod";

// Type definitions
interface StockSearchParams {
  symbol: string;
}

// Extract schema
const StockQuoteSchema = z.object({
  symbol: z.string().describe("Stock ticker symbol"),
  price: z.string().describe("Current price"),
  change: z.string().optional().describe("Price change"),
  changePercent: z.string().optional().describe("Percent change"),
  volume: z.string().optional().describe("Trading volume"),
  marketCap: z.string().optional().describe("Market capitalization"),
  peRatio: z.string().optional().describe("Price-to-earnings ratio"),
});

type StockQuoteResult = z.infer<typeof StockQuoteSchema>;

/**
 * Get stock quote from Yahoo Finance
 * @param params - Stock search parameters including symbol
 * @returns Promise with extracted stock data
 */
async function getStockQuote(
  params: StockSearchParams
): Promise<StockQuoteResult> {
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

    // Navigate to Yahoo Finance
    await page.goto("https://finance.yahoo.com");

    // Wait for page to load
    await page.waitForTimeout(2000);

    // Search for stock symbol
    await page.aiAction(`fill the search box with ${params.symbol}`);
    await page.aiAction("press Enter");

    // Wait for quote page to load
    await page.waitForTimeout(3000);

    // Extract stock data
    const result = await page.extract(
      "Extract the stock quote including symbol, current price, change, change percent, volume, market cap, and P/E ratio",
      StockQuoteSchema
    );

    return result as StockQuoteResult;
  } catch (error) {
    console.error("Error in getStockQuote:", error);
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
  getStockQuote({
    symbol: "AAPL",
  })
    .then((result) => {
      console.log("\n===== Stock Quote Results =====");
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error("Failed:", error);
      process.exit(1);
    });
}

export { getStockQuote, StockQuoteSchema };
