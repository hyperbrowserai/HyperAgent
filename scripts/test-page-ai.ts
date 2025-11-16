import { HyperAgent } from "../src/agent";
import dotenv from "dotenv";

dotenv.config();

(async () => {
  const agent = new HyperAgent({
    llm: {
      provider: "anthropic",
      model: "claude-sonnet-4-0",
    },
    // llm: {
    //   provider: "openai",
    //   model: "gpt-4o",
    // },
    browserProvider: "Hyperbrowser",
    debug: true,
    debugOptions: {
      cdpSessions: true,
      traceWait: true,
      profileDomCapture: true,
      // structuredSchema: true,
    },
    cdpActions: true,
  });

  const page = await agent.newPage();
  page.ai(
    "Go to https://flights.google.com and find a round-trip flight from Rio de Janeiro to Los Angeles, leaving on November Dec 11, 2025, and returning on Dec 22, 2025, and select the option with the least carbon dioxide emissions.",
    {
      useDomCache: true,
      enableDomStreaming: true,
    }
  );

  const page2 = await agent.newPage();
  await page2.goto("https://maps.google.com");
  page2.ai("Find the nearest restaurant to the current page", {
    useDomCache: true,
    enableDomStreaming: true,
  });
})();

// (async () => {
//   const agent = new HyperAgent({
//     llm: {
//       provider: "anthropic",
//       model: "claude-sonnet-4-0",
//     },
//     // browserProvider: "Hyperbrowser",
//     debug: true,
//   });
//   const page = await agent.newPage();
//   page.goto("https://flights.google.com");
//   await page.aiAction("click source location box");
//   await page.aiAction("type 'Rio de Janeiro' into the source location box");
//   await page.aiAction("press enter");
//   await page.aiAction("click destination location box");
//   await page.aiAction("type 'Los Angeles' into the destination location box");
//   await page.aiAction("press enter");
//   await page.aiAction("click the departure date box");
//   await page.aiAction(
//     "fill 12/01/2025 into the departure date box"
//   );
//   await page.aiAction("click the return date box");
//   await page.aiAction("fill 12/22/2025 into the return date box");
//   await page.aiAction("click the search button");
//   await page.aiAction("click the first flight option");

//   // const page2 = await agent.newPage();
//   // await page2.goto("https://maps.google.com");
//   // page2.ai("Find the nearest restaurant to the current page");
// })();
