import { HyperAgent } from "../src/agent";
import dotenv from "dotenv";
import chalk from "chalk";

dotenv.config();

const agent = new HyperAgent({
  debug: true,
});

(async () => {
  agent.addVariable({
    key: "departure_date",
    description: "Enter this date as the departure date",
    value: "May 15, 2025",
  });
  agent.addVariable({
    key: "returning_date",
    description: "Enter this date as the return date",
    value: "May 22, 2025",
  });
  const result = await agent.executeTask(
    "Go to https://flights.google.com and find a round-trip flight from Rio de Janeiro to Los Angeles and select the option with the least carbon dioxide emissions.",
    {
      debugOnAgentOutput: (agentOutput) => {
        console.log("\n" + chalk.cyan.bold("===== AGENT OUTPUT ====="));
        console.dir(agentOutput, { depth: null, colors: true });
        console.log(chalk.cyan.bold("===============") + "\n");
      },
      onStep: (step) => {
        console.log("\n" + chalk.cyan.bold("===== STEP ====="));
        console.dir(step, { depth: null, colors: true });
        console.log(chalk.cyan.bold("===============") + "\n");
      },
    }
  );
  console.log(chalk.green.bold("\nResult:"));
  console.log(chalk.white(result.output));
})();
