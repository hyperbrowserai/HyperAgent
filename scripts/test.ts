import { HyperAgent } from "../src/agent";
import dotenv from "dotenv";
import chalk from "chalk";
import { AgentOutput, AgentStep} from "../dist/types";

dotenv.config();

const agent = new HyperAgent({
  debug: true,
  browserProvider: "Hyperbrowser",
});

(async () => {
  const result = await agent.executeTask(
    `Go to https://hiveword.com/location-name-generator and use extract action to get the top two countries;
    get the capitals of these two countries.
    Then go to https://flights.google.com and find the cheapest flight from the first capital to the second capital,
    departing on August 15, 2025, and returning on August 22, 2025.`,
    {
      debugOnAgentOutput: (agentOutput: AgentOutput) => {
        console.log("\n" + chalk.cyan.bold("===== AGENT OUTPUT ====="));
        console.dir(agentOutput, { depth: null, colors: true });
        console.log(chalk.cyan.bold("===============") + "\n");
      },
      onStep: (step: AgentStep) => {
        console.log("\n" + chalk.cyan.bold("===== STEP ====="));
        console.dir(step, { depth: null, colors: true });
        console.log(chalk.cyan.bold("===============") + "\n");
      },
    }
  );
  console.log(chalk.green.bold("\nResult:"));
  console.log(chalk.white(result.output));
})();
