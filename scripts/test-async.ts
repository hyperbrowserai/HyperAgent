import { HyperAgent } from "../src/agent";
import dotenv from "dotenv";
import chalk from "chalk";

dotenv.config();

const agent = new HyperAgent({
  // a: process.env.OPENAI_API_KEY,
});

(async () => {
  const control = await agent.executeTaskAsync(
    "Go to give me a summary of the second link on the show section of hacker news, be sure to actually go to it",
    {
      onStep: (step) => {
        console.log("\n" + chalk.cyan.bold("===== STEP ====="));
        console.dir(step, { depth: null, colors: true });
        console.log(chalk.cyan.bold("===============") + "\n");
      },
    }
  );
  // console.log(chalk.green.bold("\nResult:"));
  // console.log(chalk.white(result.output));
  await new Promise((resolve) => setTimeout(resolve, 10000));
  console.log("pausing");
  control.pause();
  await new Promise((resolve) => setTimeout(resolve, 20000));
  console.log("resuming");
  control.resume();
})();
