<div align="center">
  <img src="assets/hyperagent-banner.png" alt="Hyperagent Banner" width="800"/>

  <p align="center">
    <strong>Intelligent Browser Automation with LLMs</strong>
  </p>

  <p align="center">
    <a href="https://www.npmjs.com/package/@hyperbrowser/agent">
      <img src="https://img.shields.io/npm/v/@hyperbrowser/agent?style=flat-square" alt="npm version" />
    </a>
    <a href="https://github.com/hyperbrowserai/hyperagent/blob/main/LICENSE">
      <img src="https://img.shields.io/npm/l/@hyperbrowser/agent?style=flat-square" alt="license" />
    </a>
    <a href="https://discord.gg/zsYzsgVRjh" style="text-decoration:none;">
      <img alt="Discord" src="https://img.shields.io/discord/1313014141165764619?style=flat-square&color=blue">
    </a>
    <a href="https://x.com/AkshayShekhaw12">
      <img alt="X (formerly Twitter) Follow" src="https://img.shields.io/twitter/follow/AkshayShekhaw12?style=social">
    </a>
  </p>
</div>

## Overview

Hyperagent is Playwright supercharged with AI. No more brittle scripts, just powerful natural language commands.
Just looking for scalable headless browsers or scraping infra? Go to [Hyperbrowser](https://app.hyperbrowser.ai/) to get started for free!

### Features

- 🤖 **AI Commands**: Simple APIs like `page.ai()`, `page.extract()` and `executeTask()` for any AI automation
- ⚡ **Fallback to Regular Playwright**: Use regular Playwright when AI isn't needed
- 🥷 **Stealth Mode** – Avoid detection with built-in anti-bot patches
- ☁️ **Cloud Ready** – Instantly scale to hundreds of sessions via [Hyperbrowser](https://app.hyperbrowser.ai/)
- 🔌 **MCP Client** – Connect to tools like Composio for full workflows (e.g. writing web data to Google Sheets)

## Quick Start

### Installation

```bash
# Using npm
npm install @hyperbrowser/agent

# Using yarn
yarn add @hyperbrowser/agent
```

### CLI

```bash
$ npx @hyperbrowser/agent -c "Find a route from Miami to New Orleans, and provide the detailed route information."
```

<p align="center">
  <img src="assets/flight-schedule.gif" alt="Hyperagent Demo"/>
</p>

The CLI supports options for debugging or using hyperbrowser instead of a local browser

```bash
-d, --debug                       Enable debug mode
-c, --command <task description>  Command to run
--hyperbrowser                    Use Hyperbrowser for the browser provider
```

### Library

```typescript
import { HyperAgent } from "@hyperbrowser/agent";
import { z } from "zod";

// Initialize the agent
const agent = new HyperAgent({
  llm: {
    provider: "openai",
    model: "gpt-4o",
  },
});

// Execute a task
const result = await agent.executeTask(
  "Navigate to amazon.com, search for 'laptop', and extract the prices of the first 5 results"
);
console.log(result.output);

// Use page.ai and page.extract
const page = await agent.newPage();
await page.goto("https://flights.google.com", { waitUntil: "load" });
await page.ai("search for flights from Rio to LAX from July 16 to July 22");
const res = await page.extract(
  "give me the flight options",
  z.object({
    flights: z.array(
      z.object({
        price: z.number(),
        departure: z.string(),
        arrival: z.string(),
      })
    ),
  })
);
console.log(res);

// Clean up
await agent.closeAgent();
```

## Two Modes of Operation

HyperAgent provides two complementary APIs optimized for different use cases:

### 🎯 `page.aiAction()` - Single Granular Actions

**Best for**: Single, specific actions like "click login", "fill email with test@example.com"

**Advantages**:
- ⚡ **Fast** - Uses accessibility tree (no screenshots)
- 💰 **Cheap** - Single LLM call per action
- 🎯 **Reliable** - Direct element finding and execution
- 📊 **Efficient** - Text-based DOM analysis

**Example**:
```typescript
const page = await agent.newPage();
await page.goto("https://example.com/login");

// Fast, reliable single actions
await page.aiAction("fill email with user@example.com");
await page.aiAction("fill password with mypassword");
await page.aiAction("click the login button");
```

### 🧠 `page.ai()` - Complex Multi-Step Tasks

**Best for**: Complex workflows requiring multiple steps and visual context

**Advantages**:
- 🖼️ **Visual Understanding** - Uses screenshots with element overlays
- 🎭 **Complex Tasks** - Handles multi-step workflows automatically
- 🧠 **Context-Aware** - Better at understanding page layout and relationships
- 🔄 **Adaptive** - Can adjust strategy based on page state

**Example**:
```typescript
const page = await agent.newPage();
await page.goto("https://flights.google.com");

// Complex task with multiple steps handled automatically
await page.ai("search for flights from Miami to New Orleans on July 16");
```

### 🎨 Mix and Match

Combine both APIs for optimal performance:

```typescript
// Use aiAction for fast, reliable individual actions
await page.aiAction("click the search button");
await page.aiAction("type laptop into search");

// Use ai() for complex, multi-step workflows
await page.ai("filter results by price under $1000 and sort by rating");

// Extract structured data
const products = await page.extract(
  "get the top 5 products",
  z.object({
    products: z.array(z.object({ name: z.string(), price: z.number() }))
  })
);
```

## ☁️ Cloud

You can scale HyperAgent with cloud headless browsers using Hyperbrowser

1. Get a free api key from [Hyperbrowser](https://app.hyperbrowser.ai/)
2. Add it to your env as `HYPERBROWSER_API_KEY`
3. Set your `browserProvider` to `"Hyperbrowser"`

```typescript
const agent = new HyperAgent({
  browserProvider: "Hyperbrowser",
});

const response = await agent.executeTask(
  "Go to hackernews, and list me the 5 most recent article titles"
);

console.log(response);
await agent.closeAgent();
```

## Usage Guide

### Multi-Page Management

```typescript
// Create and manage multiple pages
const page1 = await agent.newPage();
const page2 = await agent.newPage();

// Execute tasks on specific pages
const page1Response = await page1.ai(
  "Go to google.com/travel/explore and set the starting location to New York. Then, return to me the first recommended destination that shows up. Return to me only the name of the location."
);
const page2Response = await page2.ai(
  `I want to plan a trip to ${page1Response.output}. Recommend me places to visit there.`
);

console.log(page2Response.output);

// Get all active pages
const pages = await agent.getPages();
await agent.closeAgent();
```

## Customization

### Output Schema Definition

HyperAgent can extract data in a specified schema. The schema can be passed in at a per-task level

```typescript
import { z } from "zod";

const agent = new HyperAgent();
const agentResponse = await agent.executeTask(
  "Navigate to imdb.com, search for 'The Matrix', and extract the director, release year, and rating",
  {
    outputSchema: z.object({
      director: z.string().describe("The name of the movie director"),
      releaseYear: z.number().describe("The year the movie was released"),
      rating: z.string().describe("The IMDb rating of the movie"),
    }),
  }
);
console.log(agentResponse.output);
await agent.closeAgent();
```

```bash
{
  "director": "Lana Wachowski, Lilly Wachowski",
  "releaseYear": 1999,
  "rating": "8.7/10"
}
```

### Using Different LLM Providers

Hyperagent supports multiple LLM providers with native SDKs for better performance and reliability.

```typescript
// Using OpenAI
const agent = new HyperAgent({
  llm: {
    provider: "openai",
    model: "gpt-4o",
  },
});

// Using Anthropic's Claude
const agent = new HyperAgent({
  llm: {
    provider: "anthropic",
    model: "claude-3-7-sonnet-latest",
  },
});

    // Using Google Gemini
    const agent = new HyperAgent({
      llm: {
        provider: "gemini",
        model: "gemini-2.5-pro-preview-03-25",
      },
    });

    // Using DeepSeek
    const agent = new HyperAgent({
      llm: {
        provider: "deepseek",
        model: "deepseek-chat",
      },
    });
```

### MCP Support

HyperAgent functions as a fully functional MCP client. For best results, we recommend using
`gpt-4o` as your LLM.

Here is an example which reads from wikipedia, and inserts information into a google sheet using the composio Google Sheet MCP. For the full example, see [here](https://github.com/hyperbrowserai/HyperAgent/tree/main/examples/mcp/google-sheets/most-populated-states.ts)

```typescript
const agent = new HyperAgent({
  llm: llm,
  debug: true,
});

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

const response = await agent.executeTask(
  "Go to https://en.wikipedia.org/wiki/List_of_U.S._states_and_territories_by_population and get the data on the top 5 most populous states from the table. Then insert that data into a google sheet. You may need to first check if there is an active connection to google sheet, and if there isn't connect to it and present me with the link to sign in. "
);

console.log(response);
await agent.closeAgent();
```

### Custom Actions

HyperAgent's capabilities can be extended with custom actions. Custom actions require 3 things:

- type: Name of the action. Should be something descriptive about the action.
- actionParams: A zod object describing the parameters that the action may consume.
- run: A function that takes in a context, and the params for the action and produces a result based on the params.

Here is an example that performs a search using Exa

```typescript
const exaInstance = new Exa(process.env.EXA_API_KEY);

export const RunSearchActionDefinition: AgentActionDefinition = {
  type: "perform_search",
  actionParams: z.object({
    search: z
      .string()
      .describe(
        "The search query for something you want to search about. Keep the search query concise and to-the-point."
      ),
  }).describe("Search and return the results for a given query.");,
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
      message: `Succesfully performed search for query ${params.search}. Got results: \n${results}`,
    };
  },
};

const agent = new HyperAgent({
  "Search about the news for today in New York",
  customActions: [RunSearchActionDefinition],
});
```

## Contributing

We welcome contributions to Hyperagent! Here's how you can help:

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## Support

- 📚 [Documentation](https://docs.hyperbrowser.ai/hyperagent/about-hyperagent)
- 💬 [Discord Community](https://discord.gg/zsYzsgVRjh)
- 🐛 [Issue Tracker](https://github.com/hyperbrowserai/HyperAgent/issues)
- 📧 [Email Support](mailto:info@hyperbrowser.ai)
