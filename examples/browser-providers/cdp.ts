import { CDPBrowserProvider } from "../../src/browser-providers/cdp";

async function main() {
  // Example usage of CDP Browser Provider
  // Replace with your actual CDP WebSocket endpoint
  const cdpProvider = new CDPBrowserProvider({
    wsEndpoint: "ws://localhost:9222/devtools/browser", // Example CDP endpoint
    debug: true,
    options: {
      // Optional CDP connection options
      timeout: 30000,
    }
  });

  try {
    console.log("Starting CDP browser connection...");
    const browser = await cdpProvider.start();
    
    console.log("CDP browser connected successfully!");
    
    // Create a new page and navigate to a website
    const page = await browser.newPage();
    await page.goto("https://example.com");
    
    console.log("Page title:", await page.title());
    
    // Close the connection
    await cdpProvider.close();
    console.log("CDP browser connection closed.");
    
  } catch (error) {
    console.error("Error using CDP browser provider:", error);
  }
}

if (require.main === module) {
  main().catch(console.error);
}
