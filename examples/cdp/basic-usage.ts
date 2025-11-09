/**
 * Basic usage example for CDP Connection Manager
 *
 * This is a simple example showing how to:
 * 1. Launch Chrome
 * 2. Navigate to a website
 * 3. Take a screenshot
 * 4. Clean up
 */

import { CDPConnectionManager } from "../../src/cdp/connection-manager";

async function main() {
  console.log("Starting CDP Connection Manager basic usage example...\n");

  const manager = new CDPConnectionManager();

  try {
    // Step 1: Launch Chrome locally
    console.log("1. Launching Chrome...");
    const endpoint = await manager.launchLocal({
      headless: false, // Set to true for headless mode
      args: ["--window-size=1280,720"],
    });
    console.log(`   Chrome launched at: ${endpoint}\n`);

    // Step 2: Connect to the browser
    console.log("2. Connecting to browser...");
    await manager.connect(endpoint);
    console.log("   Connected!\n");

    // Step 3: Create a new page
    console.log("3. Creating a new page...");
    const session = await manager.createSession(); // Creates a blank page
    console.log(`   Session created: ${session.sessionId}\n`);

    // Step 4: Enable required domains
    console.log("4. Enabling Page domain...");
    await manager.sendCommand(session, "Page.enable", {});
    console.log("   Page domain enabled\n");

    // Step 5: Navigate to a website
    console.log("5. Navigating to example.com...");
    await manager.sendCommand(session, "Page.navigate", {
      url: "https://example.com",
    });
    console.log("   Navigation started\n");

    // Step 6: Wait for page to load
    console.log("6. Waiting for page to load...");
    await new Promise((resolve) => setTimeout(resolve, 3000));
    console.log("   Page loaded\n");

    // Step 7: Take a screenshot
    console.log("7. Taking a screenshot...");
    const { data } = await manager.sendCommand(session, "Page.captureScreenshot", {
      format: "png",
      quality: 80,
    });
    console.log(`   Screenshot captured (${data.length} bytes of base64 data)\n`);

    // Step 8: Get page title
    console.log("8. Getting page title...");
    const result = await manager.sendCommand(session, "Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    });
    console.log(`   Page title: "${result.result.value}"\n`);

    // Step 9: List all targets
    console.log("9. Listing all targets...");
    const targets = await manager.listTargets();
    console.log(`   Found ${targets.length} target(s):`);
    targets.forEach((target, index) => {
      console.log(`   ${index + 1}. [${target.type}] ${target.title}`);
    });
    console.log();

    // Step 10: Clean up
    console.log("10. Cleaning up...");
    await manager.close();
    console.log("    Done!\n");

    console.log("✓ Example completed successfully!");

  } catch (error: any) {
    console.error("\n✗ Error:", error.message);
    console.error(error.stack);

    // Ensure cleanup on error
    try {
      await manager.close();
    } catch (e) {
      // Ignore cleanup errors
    }

    process.exit(1);
  }
}

// Run the example
main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
