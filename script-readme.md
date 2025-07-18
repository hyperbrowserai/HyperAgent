# HyperAgent Script Generation Guide

## Overview

HyperAgent's `generateScript` feature allows you to automatically generate standalone TypeScript scripts from your agent's task execution. This is invaluable for debugging, reproducing issues, and creating reusable automation scripts.

## Table of Contents
- [Enabling Script Generation](#enabling-script-generation)
- [How It Works](#how-it-works)
- [Using Generated Scripts](#using-generated-scripts)
- [Example](#example)

## Enabling Script Generation

To enable script generation, set `generateScript: true` when initializing HyperAgent:

```typescript
import { HyperAgent } from "@hyperbrowser/agent";

const agent = new HyperAgent({
  debug: true,  // Enable `debug` for comprehensive output
  browserProvider: "Hyperbrowser",
  generateScript: true,  // Enable script generation
  scriptPath: "scripts/script.ts",  // Optional: specify the path; by default it goes to debug folder: debug/{taskId}
  tokenLimit: 50000,
  hyperbrowserConfig: {
    sessionConfig: {
      useProxy: true,
    },
  },
});
```

## How It Works

When `generateScript` is enabled:

1. **Task Execution**: HyperAgent executes your task normally
2. **Action Recording**: Each action performed by the agent successfully is recorded
3. **Code Generation**: After task completion, HyperAgent generates TypeScript code that reproduces the exact sequence of actions
4. **Script Output**: The generated script is saved to the debug directory or the ${scriptPath} if specified

## Using Generated Scripts

### Running a Generated Script

**Execution**:
```bash
# Ensure your .env file contains necessary API keys
npx ts-node debug/{taskId}/script.ts
```

### **Enable Debug Mode**
Strongly suggest use `debug: true` with `generateScript: true` for comprehensive output:
```typescript
const agent = new HyperAgent({
  debug: true,
  generateScript: true,
  // ...
});
```

## **Example**
Here is an example to summarize "AI agents" related papers (top 3).  
Once the job finished, you should get the generated script `debug/{taskId}/script.ts`, then you can run the following command line to reproduce the result: `npx ts-node debug/{taskId}/script.ts`
```typescript
import { HyperAgent } from "../src/agent";
import dotenv from "dotenv";
import chalk from "chalk";
import { AgentOutput, AgentStep} from "../src/types/agent/types";

dotenv.config();

const agent = new HyperAgent({
  debug: true,
  browserProvider: "Hyperbrowser",
  tokenLimit: 50000,
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
```
