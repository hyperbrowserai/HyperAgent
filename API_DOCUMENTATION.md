# HyperAgent API Documentation

## Table of Contents

1. [Overview](#overview)
2. [Installation](#installation)
3. [Core Classes](#core-classes)
4. [Types and Interfaces](#types-and-interfaces)
5. [Configuration](#configuration)
6. [Actions System](#actions-system)
7. [Custom Actions](#custom-actions)
8. [Browser Providers](#browser-providers)
9. [MCP (Model Context Protocol) Support](#mcp-model-context-protocol-support)
10. [CLI Interface](#cli-interface)
11. [Examples](#examples)
12. [Error Handling](#error-handling)

## Overview

HyperAgent is a powerful browser automation library that combines Playwright with AI capabilities. It allows you to control browsers using natural language commands while maintaining the ability to fall back to traditional Playwright scripting when needed.

### Key Features

- 🤖 **AI Commands**: Simple APIs like `page.ai()`, `page.extract()` and `executeTask()` for any AI automation
- ⚡ **Fallback to Regular Playwright**: Use regular Playwright when AI isn't needed
- 🥷 **Stealth Mode**: Avoid detection with built-in anti-bot patches
- ☁️ **Cloud Ready**: Instantly scale to hundreds of sessions via Hyperbrowser
- 🔌 **MCP Client**: Connect to tools like Composio for full workflows

## Installation

```bash
# Using npm
npm install @hyperbrowser/agent

# Using yarn
yarn add @hyperbrowser/agent
```

## Core Classes

### HyperAgent

The main class for browser automation with AI capabilities.

#### Constructor

```typescript
new HyperAgent<T extends BrowserProviders = "Local">(config?: HyperAgentConfig<T>)
```

**Parameters:**
- `config` (optional): Configuration object for the agent

**Example:**
```typescript
import { HyperAgent } from "@hyperbrowser/agent";
import { ChatOpenAI } from "@langchain/openai";

const agent = new HyperAgent({
  llm: new ChatOpenAI({
    openAIApiKey: process.env.OPENAI_API_KEY,
    modelName: "gpt-4o",
  }),
  browserProvider: "Local", // or "Hyperbrowser"
  debug: true,
});
```

#### Methods

##### `executeTask(task: string, params?: TaskParams, initPage?: Page): Promise<TaskOutput>`

Execute a task and wait for completion.

**Parameters:**
- `task`: Natural language description of the task to perform
- `params` (optional): Task parameters including output schema and callbacks
- `initPage` (optional): Specific page to use for the task

**Returns:** Promise resolving to task output

**Example:**
```typescript
const result = await agent.executeTask(
  "Navigate to amazon.com, search for 'laptop', and extract the prices of the first 5 results"
);
console.log(result.output);
```

##### `executeTaskAsync(task: string, params?: TaskParams, initPage?: Page): Promise<Task>`

Execute a task asynchronously and return a Task control object.

**Parameters:**
- `task`: Natural language description of the task to perform
- `params` (optional): Task parameters
- `initPage` (optional): Specific page to use for the task

**Returns:** Promise resolving to a Task control object

**Example:**
```typescript
const task = await agent.executeTaskAsync(
  "Navigate to google.com and search for 'AI automation'",
  {
    onStep: (step) => console.log(`Step ${step.idx}: ${step.agentOutput.nextGoal}`),
    onComplete: (output) => console.log("Task completed:", output.output)
  }
);

// Control the task
task.pause();
task.resume();
task.cancel();
```

##### `newPage(): Promise<HyperPage>`

Create a new page in the browser context.

**Returns:** Promise resolving to a HyperPage object

**Example:**
```typescript
const page = await agent.newPage();
await page.goto("https://example.com");
await page.ai("Click on the login button");
```

##### `getPages(): Promise<HyperPage[]>`

Get all pages in the current browser context.

**Returns:** Promise resolving to array of HyperPage objects

**Example:**
```typescript
const pages = await agent.getPages();
console.log(`Currently have ${pages.length} pages open`);
```

##### `getCurrentPage(): Promise<Page>`

Get the current page or create a new one if none exists.

**Returns:** Promise resolving to the current page

##### `closeAgent(): Promise<void>`

Close the agent and all associated resources.

**Example:**
```typescript
await agent.closeAgent();
```

##### `initializeMCPClient(config: MCPConfig): Promise<void>`

Initialize the MCP client with the given configuration.

**Parameters:**
- `config`: MCP configuration object

**Example:**
```typescript
await agent.initializeMCPClient({
  servers: [
    {
      command: "npx",
      args: ["@composio/mcp@latest", "start", "--url", "https://mcp.composio.dev/googlesheets/..."],
      env: { npm_config_yes: "true" }
    }
  ]
});
```

##### `connectToMCPServer(serverConfig: MCPServerConfig): Promise<string | null>`

Connect to an MCP server at runtime.

**Parameters:**
- `serverConfig`: Configuration for the MCP server

**Returns:** Promise resolving to server ID if successful, null otherwise

##### `disconnectFromMCPServer(serverId: string): boolean`

Disconnect from a specific MCP server.

**Parameters:**
- `serverId`: ID of the server to disconnect from

**Returns:** Boolean indicating success

##### Variable Management

```typescript
// Add a variable
agent.addVariable({
  key: "userEmail",
  value: "user@example.com",
  description: "User's email address"
});

// Get a variable
const email = agent.getVariable("userEmail");

// Get all variables
const allVars = agent.getVariables();

// Delete a variable
agent.deleteVariable("userEmail");
```

### HyperPage

Extended Playwright Page with AI capabilities.

#### Methods

##### `ai(task: string, params?: TaskParams): Promise<TaskOutput>`

Execute an AI task on the current page.

**Parameters:**
- `task`: Natural language description of what to do
- `params` (optional): Task parameters

**Returns:** Promise resolving to task output

**Example:**
```typescript
const page = await agent.newPage();
await page.goto("https://flights.google.com");
await page.ai("search for flights from Rio to LAX from July 16 to July 22");
```

##### `aiAsync(task: string, params?: TaskParams): Promise<Task>`

Execute an AI task asynchronously on the current page.

**Parameters:**
- `task`: Natural language description of what to do
- `params` (optional): Task parameters

**Returns:** Promise resolving to a Task control object

##### `extract<T>(task?: string, outputSchema?: T): Promise<T extends z.AnyZodObject ? z.infer<T> : string>`

Extract structured data from the current page.

**Parameters:**
- `task` (optional): Description of what to extract
- `outputSchema` (optional): Zod schema for structured output

**Returns:** Promise resolving to extracted data

**Example:**
```typescript
import { z } from "zod";

const flightSchema = z.object({
  flights: z.array(
    z.object({
      price: z.number(),
      departure: z.string(),
      arrival: z.string(),
    })
  ),
});

const flights = await page.extract("give me the flight options", flightSchema);
console.log(flights);
```

## Types and Interfaces

### TaskParams

Configuration parameters for task execution.

```typescript
interface TaskParams {
  maxSteps?: number;
  debugDir?: string;
  outputSchema?: z.AnyZodObject;
  onStep?: (step: AgentStep) => Promise<void> | void;
  onComplete?: (output: TaskOutput) => Promise<void> | void;
  debugOnAgentOutput?: (step: AgentOutput) => void;
}
```

### TaskOutput

Result of task execution.

```typescript
interface TaskOutput {
  status?: TaskStatus;
  steps: AgentStep[];
  output?: string;
}
```

### TaskStatus

Enumeration of possible task statuses.

```typescript
enum TaskStatus {
  PENDING = "pending",
  RUNNING = "running",
  PAUSED = "paused",
  CANCELLED = "cancelled",
  COMPLETED = "completed",
  FAILED = "failed",
}
```

### Task

Control object for managing running tasks.

```typescript
interface Task {
  getStatus: () => TaskStatus;
  pause: () => TaskStatus;
  resume: () => TaskStatus;
  cancel: () => TaskStatus;
  emitter: ErrorEmitter;
}
```

### AgentStep

Represents a single step in task execution.

```typescript
interface AgentStep {
  idx: number;
  agentOutput: AgentOutput;
  actionOutputs: ActionOutput[];
}
```

### HyperVariable

Variable that can be stored and used across tasks.

```typescript
interface HyperVariable {
  key: string;
  value: string;
  description: string;
}
```

## Configuration

### HyperAgentConfig

Main configuration interface for HyperAgent.

```typescript
interface HyperAgentConfig<T extends BrowserProviders = "Local"> {
  customActions?: Array<AgentActionDefinition>;
  browserProvider?: T;
  debug?: boolean;
  llm?: BaseChatModel;
  hyperbrowserConfig?: HyperbrowserConfig;
  localConfig?: LocalBrowserConfig;
}
```

**Example:**
```typescript
const config: HyperAgentConfig = {
  llm: new ChatOpenAI({
    openAIApiKey: process.env.OPENAI_API_KEY,
    modelName: "gpt-4o",
    temperature: 0,
  }),
  browserProvider: "Hyperbrowser",
  debug: true,
  customActions: [myCustomAction],
};
```

### MCPConfig

Configuration for Model Context Protocol servers.

```typescript
interface MCPConfig {
  servers: MCPServerConfig[];
}

interface MCPServerConfig {
  id?: string;
  connectionType?: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  sseUrl?: string;
  sseHeaders?: Record<string, string>;
  excludeTools?: string[];
  includeTools?: string[];
}
```

## Actions System

HyperAgent uses an action-based system where the AI agent can perform various actions on web pages.

### Built-in Actions

The following actions are available by default:

- **go_to_url**: Navigate to a specific URL
- **click_element**: Click on page elements
- **input_text**: Type text into form fields
- **select_option**: Select options from dropdowns
- **scroll**: Scroll the page
- **page_back**: Navigate back in browser history
- **page_forward**: Navigate forward in browser history
- **refresh_page**: Refresh the current page
- **key_press**: Press specific keys
- **extract**: Extract data from the page
- **thinking**: Internal reasoning step
- **complete**: Mark task as complete
- **pdf**: Handle PDF documents (requires GEMINI_API_KEY)

### ActionContext

Context provided to actions during execution.

```typescript
interface ActionContext {
  page: Page;
  domState: DOMState;
  llm: BaseChatModel;
  tokenLimit: number;
  variables: HyperVariable[];
  debugDir?: string;
  mcpClient?: MCPClient;
}
```

### ActionOutput

Result of action execution.

```typescript
interface ActionOutput {
  success: boolean;
  message: string;
  extract?: object;
}
```

## Custom Actions

You can extend HyperAgent's capabilities by creating custom actions.

### AgentActionDefinition

Interface for defining custom actions.

```typescript
interface AgentActionDefinition<T extends z.AnyZodObject = z.AnyZodObject> {
  readonly type: string;
  actionParams: T;
  run(ctx: ActionContext, params: z.infer<T>): Promise<ActionOutput>;
  completeAction?(params: z.infer<T>): Promise<string>;
  pprintAction?(params: z.infer<T>): string;
}
```

### Creating Custom Actions

**Example: Search Action using Exa**

```typescript
import { z } from "zod";
import { AgentActionDefinition, ActionContext, ActionOutput } from "@hyperbrowser/agent/types";
import { Exa } from "exa-js";

const searchSchema = z.object({
  search: z.string().describe(
    "The search query for something you want to search about. Keep the search query concise and to-the-point."
  ),
});

const exaInstance = new Exa(process.env.EXA_API_KEY);

export const RunSearchActionDefinition: AgentActionDefinition = {
  type: "perform_search",
  actionParams: searchSchema.describe("Search and return the results for a given query."),
  run: async function (
    ctx: ActionContext,
    params: z.infer<typeof searchSchema>
  ): Promise<ActionOutput> {
    const results = (await exaInstance.search(params.search, {})).results
      .map(
        (res) =>
          `title: ${res.title} || url: ${res.url} || relevance: ${res.score}`
      )
      .join("\n");

    return {
      success: true,
      message: `Successfully performed search for query ${params.search}. Got results: \n${results}`,
    };
  },
};

// Use the custom action
const agent = new HyperAgent({
  customActions: [RunSearchActionDefinition],
});
```

### UserInteractionAction

Built-in custom action for user interaction.

```typescript
import { UserInteractionAction } from "@hyperbrowser/agent/custom-actions";

const userAction = UserInteractionAction(
  async ({ message, kind, choices }) => {
    // Handle user interaction
    if (kind === "text_input") {
      const response = await getUserInput(message);
      return {
        success: true,
        message: `User responded with: "${response}"`,
      };
    }
    // Handle other interaction types...
  }
);

const agent = new HyperAgent({
  customActions: [userAction],
});
```

## Browser Providers

HyperAgent supports two browser providers:

### Local Browser Provider

Uses local Playwright browser instances.

```typescript
const agent = new HyperAgent({
  browserProvider: "Local",
  localConfig: {
    // Playwright launch options
    headless: false,
    slowMo: 1000,
  },
});
```

### Hyperbrowser Provider

Uses cloud-based Hyperbrowser instances for scalability.

```typescript
const agent = new HyperAgent({
  browserProvider: "Hyperbrowser",
  hyperbrowserConfig: {
    apiKey: process.env.HYPERBROWSER_API_KEY,
    // Additional Hyperbrowser configuration
  },
});
```

## MCP (Model Context Protocol) Support

HyperAgent functions as a fully functional MCP client, allowing integration with various tools and services.

### Initializing MCP

```typescript
await agent.initializeMCPClient({
  servers: [
    {
      command: "npx",
      args: [
        "@composio/mcp@latest",
        "start",
        "--url",
        "https://mcp.composio.dev/googlesheets/...",
      ],
      env: {
        npm_config_yes: "true",
      },
    },
  ],
});
```

### Runtime MCP Management

```typescript
// Connect to a server at runtime
const serverId = await agent.connectToMCPServer({
  command: "npx",
  args: ["@composio/mcp@latest", "start", "--url", "..."],
});

// Check connection status
const isConnected = agent.isMCPServerConnected(serverId);

// Get server information
const serverInfo = agent.getMCPServerInfo();

// Disconnect from a server
agent.disconnectFromMCPServer(serverId);
```

## CLI Interface

HyperAgent provides a command-line interface for interactive use.

### Basic Usage

```bash
# Interactive mode
npx @hyperbrowser/agent

# Direct command execution
npx @hyperbrowser/agent -c "Find a route from Miami to New Orleans"

# With debug mode
npx @hyperbrowser/agent -d -c "Search for laptops on Amazon"

# Using Hyperbrowser
npx @hyperbrowser/agent --hyperbrowser -c "Navigate to Google"

# From file
npx @hyperbrowser/agent -f ./task.txt

# With MCP configuration
npx @hyperbrowser/agent -m ./mcp-config.json
```

### CLI Options

- `-d, --debug`: Enable debug mode
- `-c, --command <task>`: Command to run
- `-f, --file <path>`: Path to file containing command
- `-m, --mcp <path>`: Path to MCP configuration file
- `--hyperbrowser`: Use Hyperbrowser provider

### Interactive Controls

During task execution:
- **Ctrl+P**: Pause the current task
- **Ctrl+R**: Resume a paused task
- **Ctrl+C**: Cancel and exit

## Examples

### Basic Task Execution

```typescript
import { HyperAgent } from "@hyperbrowser/agent";
import { ChatOpenAI } from "@langchain/openai";

const agent = new HyperAgent({
  llm: new ChatOpenAI({
    openAIApiKey: process.env.OPENAI_API_KEY,
    modelName: "gpt-4o",
  }),
});

const result = await agent.executeTask(
  "Navigate to amazon.com, search for 'laptop', and extract the prices of the first 5 results"
);

console.log(result.output);
await agent.closeAgent();
```

### Multi-Page Management

```typescript
// Create multiple pages
const page1 = await agent.newPage();
const page2 = await agent.newPage();

// Execute tasks on specific pages
const page1Response = await page1.ai(
  "Go to google.com/travel/explore and set the starting location to New York"
);

const page2Response = await page2.ai(
  `Plan a trip to ${page1Response.output}`
);

// Get all active pages
const pages = await agent.getPages();
```

### Structured Data Extraction

```typescript
import { z } from "zod";

const movieSchema = z.object({
  director: z.string().describe("The name of the movie director"),
  releaseYear: z.number().describe("The year the movie was released"),
  rating: z.string().describe("The IMDb rating of the movie"),
});

const result = await agent.executeTask(
  "Navigate to imdb.com, search for 'The Matrix', and extract the director, release year, and rating",
  { outputSchema: movieSchema }
);

console.log(result.output); // Structured data matching the schema
```

### Using Different LLM Providers

```typescript
import { ChatAnthropic } from "@langchain/anthropic";

// Using Anthropic's Claude
const agent = new HyperAgent({
  llm: new ChatAnthropic({
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    modelName: "claude-3-7-sonnet-latest",
  }),
});
```

### Task Progress Monitoring

```typescript
const result = await agent.executeTask(
  "Search for flights from NYC to LAX",
  {
    onStep: (step) => {
      console.log(`Step ${step.idx}: ${step.agentOutput.nextGoal}`);
      step.actionOutputs.forEach((output, i) => {
        console.log(`  Action ${i}: ${output.success ? 'Success' : 'Failed'}`);
      });
    },
    onComplete: (output) => {
      console.log("Task completed successfully!");
    },
    debugOnAgentOutput: (agentOutput) => {
      console.log("Agent is thinking:", agentOutput.thoughts);
    }
  }
);
```

### Variable Management

```typescript
// Set variables for use across tasks
agent.addVariable({
  key: "userEmail",
  value: "john@example.com",
  description: "User's email for form filling"
});

agent.addVariable({
  key: "searchTerm",
  value: "gaming laptop",
  description: "Product to search for"
});

// Variables are automatically available to AI tasks
await agent.executeTask(
  "Go to Amazon and search for the product stored in searchTerm variable, then add it to cart"
);
```

## Error Handling

### HyperagentError

Custom error class for HyperAgent-specific errors.

```typescript
import { HyperagentError } from "@hyperbrowser/agent";

try {
  const result = await agent.executeTask("Invalid task");
} catch (error) {
  if (error instanceof HyperagentError) {
    console.error("HyperAgent Error:", error.message);
  } else {
    console.error("General Error:", error);
  }
}
```

### ActionNotFoundError

Error thrown when a requested action is not found.

```typescript
import { ActionNotFoundError } from "@hyperbrowser/agent";

try {
  // This would throw if the action doesn't exist
  agent.pprintAction({ type: "nonexistent_action", params: {} });
} catch (error) {
  if (error instanceof ActionNotFoundError) {
    console.error("Action not found:", error.message);
  }
}
```

### Task Error Handling

```typescript
const task = await agent.executeTaskAsync("Some complex task");

task.emitter.on("error", (error) => {
  console.error("Task failed:", error.message);
  task.cancel();
});

// Check task status
if (task.getStatus() === TaskStatus.FAILED) {
  console.log("Task has failed");
}
```

### Graceful Shutdown

```typescript
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await agent.closeAgent();
  process.exit(0);
});
```

## Best Practices

1. **Always close the agent** when done to free up resources:
   ```typescript
   try {
     // Your automation code
   } finally {
     await agent.closeAgent();
   }
   ```

2. **Use structured output schemas** for reliable data extraction:
   ```typescript
   const schema = z.object({
     title: z.string(),
     price: z.number(),
   });
   const result = await agent.executeTask("Extract product info", { outputSchema: schema });
   ```

3. **Handle errors appropriately**:
   ```typescript
   try {
     const result = await agent.executeTask("Complex task");
   } catch (error) {
     if (error instanceof HyperagentError) {
       // Handle HyperAgent-specific errors
     } else {
       // Handle general errors
     }
   }
   ```

4. **Use variables for reusable data**:
   ```typescript
   agent.addVariable({
     key: "baseUrl",
     value: "https://myapp.com",
     description: "Application base URL"
   });
   ```

5. **Monitor task progress** for long-running operations:
   ```typescript
   const task = await agent.executeTaskAsync("Long task", {
     onStep: (step) => console.log(`Progress: Step ${step.idx}`),
   });
   ```

This documentation covers all public APIs, functions, and components of the HyperAgent library. For the most up-to-date information and additional examples, refer to the official repository and documentation.