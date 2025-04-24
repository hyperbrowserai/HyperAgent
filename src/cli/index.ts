#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import * as inquirer from "@inquirer/prompts";
import ora from "ora";
import boxen from "boxen";
import chalk from "chalk";
import readline from "readline";
import { zipWith } from "lodash";

import { HyperAgent } from "@/agent";
import {
  ActionType,
  AgentOutput,
  AgentStep,
  Task,
  TaskOutput,
  TaskStatus,
} from "@/types";
import { HyperagentError } from "@/agent/error";
import { SessionDetail } from "@hyperbrowser/sdk/types";

const program = new Command();

let currentSpinner = ora();

program
  .name("hyperbrowser")
  .description("CLI for Hyperbrowser - A powerful browser automation tool")
  .version("0.0.1");

program
  .command("run", { isDefault: true })
  .description("Run the interactive CLI")
  .option("-d, --debug", "Enable debug mode")
  .option("--hyperbrowser", "Use Hyperbrowser for the browser provider")
  .action(async function () {
    const options = this.opts();
    const debug = (options.debug as boolean) || false;
    const useHB = (options.hyperbrowser as boolean) || false;

    console.log(chalk.blue("HyperAgent CLI"));
    currentSpinner.info(
      `Pause using ${chalk.bold("ctrl + p")} and resume using ${chalk.bold("ctrl + r")}\n`
    );
    try {
      // Check for API key if using Hyperbrowser
      if (useHB && !process.env.HYPERBROWSER_API_KEY) {
        const apiKey = await inquirer.password({
          message:
            "Hyperbrowser API key not found in environment variables. Please enter it here:",
          mask: "*",
        });
        if (!apiKey) {
          console.log(
            chalk.yellow("Hyperbrowser API key is required. Exiting.")
          );
          process.exit(0);
        }
        process.env.HYPERBROWSER_API_KEY = apiKey; // Set it for the current process
      }

      const browser = new HyperAgent({
        debug: debug,
        browserProvider: useHB ? "Hyperbrowser" : "Local",
      });

      let task: Task;

      readline.emitKeypressEvents(process.stdin);

      process.stdin.on("keypress", async (ch, key) => {
        if (key && key.ctrl && key.name == "p") {
          if (currentSpinner.isSpinning) {
            currentSpinner.stopAndPersist({ symbol: "⏸" });
          }
          currentSpinner.start(
            chalk.blue(
              "Hyperagent will pause after completing this operation. Press Ctrl+r again to resume."
            )
          );
          currentSpinner.stopAndPersist({ symbol: "⏸" });
          currentSpinner = ora();

          if (task.getStatus() == TaskStatus.RUNNING) {
            task.pause();
          }
        } else if (key && key.ctrl && key.name == "r") {
          if (task.getStatus() == TaskStatus.PAUSED) {
            currentSpinner.start(chalk.blue("Hyperagent will resume"));
            currentSpinner.stopAndPersist({ symbol: "⏵" });
            currentSpinner = ora();

            task.resume();
          }
        } else if (key && key.ctrl && key.name == "c") {
          if (currentSpinner.isSpinning) {
            currentSpinner.stopAndPersist();
          }
          console.log("\nShutting down HyperAgent");
          try {
            await browser.closeAgent();
            process.exit(0);
          } catch (err) {
            console.error("Error during shutdown:", err);
            process.exit(1);
          }
        }
      });

      process.stdin.setRawMode(true);

      const onStep = (params: AgentStep) => {
        const actionsList = zipWith(
          params.actionOutputs,
          params.agentOutput.actions,
          (output, action) => ({
            output,
            action,
          })
        );

        const actions = actionsList
          .map((action, index, array) =>
            index < array.length - 1
              ? `  ├── [${action.output.success ? chalk.yellow(action.action.type) : chalk.red(action.action.type)}] ${action.output.success ? browser.pprintAction(action.action as ActionType) : chalk.red(action.output.message)}`
              : `  └── [${action.output.success ? chalk.yellow(action.action.type) : chalk.red(action.action.type)}] ${action.output.success ? browser.pprintAction(action.action as ActionType) : chalk.red(action.output.message)}`
          )
          .join("\n");

        currentSpinner.succeed(
          `[${chalk.yellow("task")}]: ${params.agentOutput.nextGoal}\n${actions}`
        );
        currentSpinner = ora();
        process.stdin.setRawMode(true);
        process.stdin.resume();
      };

      const debugAgentOutput = (params: AgentOutput) => {
        const actions = params.actions.map((action, index, array) =>
          index < array.length - 1
            ? `  ├── [${chalk.yellow(action.type)}] ${browser.pprintAction(action as ActionType)}`
            : `  └── [${chalk.yellow(action.type)}] ${browser.pprintAction(action as ActionType)}`
        );
        currentSpinner.start(
          `[${chalk.yellow("task")}]: ${params.nextGoal}\n${actions.join("\n")}`
        );
        process.stdin.setRawMode(true);
        process.stdin.resume();
      };

      const onComplete = async (params: TaskOutput) => {
        console.log(
          boxen(params.output || "No Response", {
            title: chalk.yellow("HyperAgent Response"),
            titleAlignment: "center",
            float: "center",
            padding: 1,
            margin: { top: 2, left: 0, right: 0, bottom: 0 },
          })
        );
        console.log("\n");
        const continueTask = await inquirer.select({
          message: "Would you like to continue ",
          choices: [
            { name: "Yes", value: true },
            { name: "No", value: false },
          ],
        });
        if (continueTask) {
          const taskDescription = await inquirer.input({
            message: "What should HyperAgent do next for you?",
            required: true,
          });

          process.stdin.setRawMode(true);
          process.stdin.resume();

          task = await browser.executeTaskAsync(taskDescription, {
            onStep: onStep,
            debugOnAgentOutput: debugAgentOutput,
            onComplete: onComplete,
          });
        } else {
          process.exit(0);
        }
      };

      const taskDescription = await inquirer.input({
        message: "What should HyperAgent do for you today?",
        required: true,
      });

      if (useHB && !debug) {
        await browser.initBrowser();
        const session = browser.getSession() as SessionDetail;
        console.log(`Hyperbrowser Live URL: ${session.liveUrl}\n`);
      }

      task = await browser.executeTaskAsync(taskDescription, {
        onStep: onStep,
        onComplete: onComplete,
        debugOnAgentOutput: debugAgentOutput,
      });
    } catch (err) {
      if (err instanceof HyperagentError || err instanceof Error) {
        console.log(chalk.red(err.message));
        if (debug) {
          console.trace(err);
        }
      } else {
        console.log(chalk.red(err));
        if (debug) {
          console.trace(err);
        }
      }
    }
  });

program.parse();
