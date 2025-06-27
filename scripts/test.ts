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
    `Go to https://flights.google.com and find a round-trip flight 
    from Rio de Janeiro to Los Angeles,
    leaving on July 15, 2025, and returning on July 22, 2025,
    and select the option with the least carbon dioxide emissions.`,
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
