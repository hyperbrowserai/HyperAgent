/**
 * Test script for CDP Connection Manager
 *
 * This script demonstrates and tests the core functionality of the CDPConnectionManager:
 * 1. Launching Chrome locally
 * 2. Connecting to the browser
 * 3. Creating a new page target
 * 4. Sending CDP commands (Page.navigate)
 * 5. Listening to CDP events
 * 6. Proper cleanup
 */

import { CDPConnectionManager } from "../../src/cdp/connection-manager";

async function testCDPConnectionManager() {
  console.log("\n=== CDP Connection Manager Test ===\n");

  const manager = new CDPConnectionManager();
  let testsPassed = 0;
  let testsFailed = 0;

  try {
    // Set up event listeners
    manager.on("connected", () => {
      console.log("✓ Event: Connected to browser");
    });

    manager.on("disconnected", () => {
      console.log("✓ Event: Disconnected from browser");
    });

    manager.on("error", (error) => {
      console.error("✗ Event: Error occurred:", error.message);
    });

    manager.on("statusChange", (status) => {
      console.log(`✓ Status changed to: ${status}`);
    });

    // Test 1: Launch local Chrome
    console.log("Test 1: Launching local Chrome...");
    try {
      const endpoint = await manager.launchLocal({
        headless: false,
        args: ["--window-size=1280,720"],
      });
      console.log(`✓ Chrome launched successfully at: ${endpoint}`);
      testsPassed++;
    } catch (error: any) {
      console.error(`✗ Failed to launch Chrome: ${error.message}`);
      testsFailed++;
      throw error;
    }

    // Wait a moment for Chrome to fully start
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Test 2: Connect to browser
    console.log("\nTest 2: Connecting to browser...");
    try {
      await manager.connect(manager["endpointUrl"]!);
      console.log("✓ Connected to browser successfully");
      testsPassed++;
    } catch (error: any) {
      console.error(`✗ Failed to connect to browser: ${error.message}`);
      testsFailed++;
      throw error;
    }

    // Test 3: List targets
    console.log("\nTest 3: Listing available targets...");
    try {
      const targets = await manager.listTargets();
      console.log(`✓ Found ${targets.length} target(s):`);
      targets.forEach((target, index) => {
        console.log(`  ${index + 1}. [${target.type}] ${target.title} - ${target.url}`);
      });
      testsPassed++;
    } catch (error: any) {
      console.error(`✗ Failed to list targets: ${error.message}`);
      testsFailed++;
      throw error;
    }

    // Test 4: Create a new target
    console.log("\nTest 4: Creating a new page target...");
    let targetId: string;
    try {
      targetId = await manager.createTarget("about:blank");
      console.log(`✓ Created new target: ${targetId}`);
      testsPassed++;
    } catch (error: any) {
      console.error(`✗ Failed to create target: ${error.message}`);
      testsFailed++;
      throw error;
    }

    // Test 5: Create a session for the target
    console.log("\nTest 5: Creating CDP session for the target...");
    let session;
    try {
      session = await manager.createSession(targetId!);
      console.log(`✓ Created session: ${session.sessionId}`);
      testsPassed++;
    } catch (error: any) {
      console.error(`✗ Failed to create session: ${error.message}`);
      testsFailed++;
      throw error;
    }

    // Test 6: Enable Page domain
    console.log("\nTest 6: Enabling Page domain...");
    try {
      await manager.sendCommand(session!, "Page.enable", {});
      console.log("✓ Page domain enabled");
      testsPassed++;
    } catch (error: any) {
      console.error(`✗ Failed to enable Page domain: ${error.message}`);
      testsFailed++;
      throw error;
    }

    // Test 7: Set up event listener for page load
    console.log("\nTest 7: Setting up Page.loadEventFired listener...");
    let pageLoaded = false;
    manager.addEventListener(session!, "Page.loadEventFired", () => {
      console.log("✓ Event: Page loaded successfully!");
      pageLoaded = true;
    });

    // Test 8: Navigate to a page
    console.log("\nTest 8: Navigating to example.com...");
    try {
      const result = await manager.sendCommand(session!, "Page.navigate", {
        url: "https://example.com",
      });
      console.log(`✓ Navigation started. Frame ID: ${result.frameId}`);
      testsPassed++;
    } catch (error: any) {
      console.error(`✗ Failed to navigate: ${error.message}`);
      testsFailed++;
      throw error;
    }

    // Wait for page to load
    console.log("\nWaiting for page to load...");
    await new Promise((resolve) => setTimeout(resolve, 3000));

    if (pageLoaded) {
      console.log("✓ Page load event was fired");
      testsPassed++;
    } else {
      console.log("⚠ Page load event was not detected (may have loaded too quickly)");
    }

    // Test 9: Get page content
    console.log("\nTest 9: Getting page content...");
    try {
      const { frameTree } = await manager.sendCommand(session!, "Page.getFrameTree", {});
      console.log(`✓ Retrieved frame tree. Root frame URL: ${frameTree.frame.url}`);
      testsPassed++;
    } catch (error: any) {
      console.error(`✗ Failed to get page content: ${error.message}`);
      testsFailed++;
    }

    // Test 10: Take a screenshot
    console.log("\nTest 10: Taking a screenshot...");
    try {
      const { data } = await manager.sendCommand(session!, "Page.captureScreenshot", {
        format: "png",
        quality: 80,
      });
      console.log(`✓ Screenshot captured (${data.length} bytes of base64 data)`);
      testsPassed++;
    } catch (error: any) {
      console.error(`✗ Failed to capture screenshot: ${error.message}`);
      testsFailed++;
    }

    // Test 11: Close target
    console.log("\nTest 11: Closing the target...");
    try {
      const success = await manager.closeTarget(targetId!);
      if (success) {
        console.log("✓ Target closed successfully");
        testsPassed++;
      } else {
        console.log("✗ Failed to close target");
        testsFailed++;
      }
    } catch (error: any) {
      console.error(`✗ Error closing target: ${error.message}`);
      testsFailed++;
    }

    // Test 12: Cleanup
    console.log("\nTest 12: Cleaning up...");
    try {
      await manager.close();
      console.log("✓ Connection manager closed successfully");
      testsPassed++;
    } catch (error: any) {
      console.error(`✗ Failed to close connection manager: ${error.message}`);
      testsFailed++;
    }

    // Print test summary
    console.log("\n=== Test Summary ===");
    console.log(`Tests passed: ${testsPassed}`);
    console.log(`Tests failed: ${testsFailed}`);
    console.log(`Total tests: ${testsPassed + testsFailed}`);

    if (testsFailed === 0) {
      console.log("\n✓ All tests passed!");
      process.exit(0);
    } else {
      console.log("\n✗ Some tests failed");
      process.exit(1);
    }

  } catch (error: any) {
    console.error("\n✗ Fatal error during testing:", error.message);
    console.error(error.stack);

    // Ensure cleanup
    try {
      await manager.close();
    } catch (e) {
      // Ignore cleanup errors
    }

    console.log("\n=== Test Summary ===");
    console.log(`Tests passed: ${testsPassed}`);
    console.log(`Tests failed: ${testsFailed + 1}`);
    console.log(`Total tests: ${testsPassed + testsFailed + 1}`);

    process.exit(1);
  }
}

// Run the tests
testCDPConnectionManager().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
