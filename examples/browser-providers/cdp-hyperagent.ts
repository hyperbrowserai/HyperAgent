import { HyperAgent, CDPBrowserProvider } from "../../src";

async function main() {
  // Example usage of CDP Browser Provider with HyperAgent
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
    console.log("Creating HyperAgent with CDP browser provider...");
    
    // Create HyperAgent with CDP provider
    const agent = new HyperAgent({
      browserProvider: cdpProvider,
      debug: true,
    });

    console.log("Executing task with CDP browser...");
    
    const response = await agent.executeTask(
      "Go to google.com and search for 'CDP browser automation'. Then tell me the title of the first search result."
    );

    console.log("Task response:", response.output);
    
    // Close the agent
    await agent.closeAgent();
    console.log("CDP HyperAgent session closed.");
    
  } catch (error) {
    console.error("Error using CDP HyperAgent:", error);
  }
}

if (require.main === module) {
  main().catch(console.error);
}
