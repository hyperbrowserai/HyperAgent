import { HyperAgent } from "../src/agent";
import dotenv from "dotenv";
import chalk from "chalk";
import { AgentOutput, AgentStep} from "../src/types/agent/types";

dotenv.config();

const agent = new HyperAgent({
  debug: true,
  browserProvider: "Hyperbrowser",
  // tokenLimit: 50000,
  generateScript: true,
  // scriptPath: "script.ts",
  hyperbrowserConfig: {
    sessionConfig: {
      useProxy: true,
    },
  },
});

(async () => {
  const result = await agent.executeTask(
    `Go to arXiv.org and search for 'AI agents' in abstract.
    Find the 3 most recent papers from the search results.
    For each paper:
    1. Extract the following information:
       - Paper title
       - All authors' names
       - Summarized abstract in 2-3 sentences
       - Submission date
    2. Compile all extracted information in your final response.`,
    {
      debugOnAgentOutput: (agentOutput: AgentOutput) => {
        console.log("\n" + chalk.cyan.bold("===== AGENT OUTPUT ====="));
        console.dir(agentOutput, { depth: null, colors: true });
        console.log(chalk.cyan.bold("===============") + "\n");
      },
      onStep: (step: AgentStep) => {
        console.log("\n" + chalk.cyan.bold(`===== STEP =====`));
        console.log(`Step: ${step.idx}`);
        console.dir(step, { depth: null, colors: true });
        console.log(chalk.cyan.bold("===============") + "\n");
      },
    }
  );
  await agent.closeAgent();
  console.log(chalk.green.bold("\nResult:"));
  console.log(chalk.white(result.output));
})();
