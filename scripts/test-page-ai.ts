import { HyperAgent } from "../src/agent";
import dotenv from "dotenv";

dotenv.config();

const agent = new HyperAgent();

(async () => {
  const page = await agent.newPage();
  page.ai(
    "Go to https://flights.google.com and find a round-trip flight from Rio de Janeiro to Los Angeles, leaving on May 15, 2025, and returning on May 22, 2025, and select the option with the least carbon dioxide emissions."
  );
  const page2 = await agent.newPage();
  await page2.goto("https://maps.google.com");
  page2.ai("Find the nearest restaurant to the current page");
})();
