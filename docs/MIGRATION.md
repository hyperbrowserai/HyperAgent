# LangChain to Native SDK Migration Guide

This guide helps you migrate from LangChain-based HyperAgent to the new native SDK implementation.

## Breaking Changes

### 1. LLM Configuration

**Before (LangChain):**
```typescript
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";

const agent = new HyperAgent({
  llm: new ChatOpenAI({
    openAIApiKey: process.env.OPENAI_API_KEY,
    modelName: "gpt-4o",
  }),
});
```

**After (Native SDK):**
```typescript
const agent = new HyperAgent({
  llm: {
    provider: "openai",
    model: "gpt-4o",
  },
});
```

### 2. Provider-Specific Configuration

**OpenAI:**
```typescript
// Before
const llm = new ChatOpenAI({
  openAIApiKey: process.env.OPENAI_API_KEY,
  modelName: "gpt-4o",
  temperature: 0.7,
  maxTokens: 1000,
});

// After
const agent = new HyperAgent({
  llm: {
    provider: "openai",
    model: "gpt-4o",
    temperature: 0.7,
    maxTokens: 1000,
  },
});
```

**Anthropic:**
```typescript
// Before
const llm = new ChatAnthropic({
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  modelName: "claude-3-7-sonnet-latest",
});

// After
const agent = new HyperAgent({
  llm: {
    provider: "anthropic",
    model: "claude-3-7-sonnet-latest",
  },
});
```

**Gemini:**
```typescript
// Before (if using LangChain Gemini)
const llm = new ChatGemini({
  apiKey: process.env.GEMINI_API_KEY,
  modelName: "gemini-2.5-pro-preview-03-25",
});

// After
const agent = new HyperAgent({
  llm: {
    provider: "gemini",
    model: "gemini-2.5-pro-preview-03-25",
  },
});
```

### 3. Direct LLM Instance Usage

If you were passing a direct LLM instance, you can still do so, but the interface has changed:

**Before:**
```typescript
import { ChatOpenAI } from "@langchain/openai";

const llm = new ChatOpenAI({...});
const agent = new HyperAgent({ llm });
```

**After:**
```typescript
import { createOpenAIClient } from "@hyperbrowser/agent/llm/providers";

const llm = createOpenAIClient({
  apiKey: process.env.OPENAI_API_KEY,
  model: "gpt-4o",
});
const agent = new HyperAgent({ llm });
```

## Migration Steps

### Step 1: Update Dependencies

Remove LangChain dependencies from your `package.json`:
```bash
npm uninstall langchain @langchain/core @langchain/openai @langchain/anthropic
```

The new dependencies are automatically included with HyperAgent.

### Step 2: Update Imports

Remove LangChain imports:
```typescript
// Remove these imports
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
```

### Step 3: Update Agent Configuration

Replace LangChain LLM instances with configuration objects:

```typescript
// Before
const agent = new HyperAgent({
  llm: new ChatOpenAI({
    openAIApiKey: process.env.OPENAI_API_KEY,
    modelName: "gpt-4o",
  }),
});

// After
const agent = new HyperAgent({
  llm: {
    provider: "openai",
    model: "gpt-4o",
  },
});
```

### Step 4: Update Environment Variables

The environment variable names remain the same:
- `OPENAI_API_KEY` for OpenAI
- `ANTHROPIC_API_KEY` for Anthropic
- `GEMINI_API_KEY` or `GOOGLE_API_KEY` for Gemini
- `DEEPSEEK_API_KEY` for DeepSeek

### Step 5: Test Your Application

Run your application to ensure everything works correctly:

```bash
yarn build
yarn cli -c "Go to hackernews and list the top 3 stories"
```

## Benefits of Migration

1. **Better Performance**: Native SDKs are optimized for their respective providers
2. **Reduced Bundle Size**: No LangChain overhead
3. **Latest Features**: Access to newest provider features immediately
4. **Better Error Handling**: Provider-specific error messages
5. **Improved Reliability**: Direct API communication without abstraction layers

## Troubleshooting

### Common Issues

1. **Import Errors**: Make sure to remove all LangChain imports
2. **Type Errors**: Update your TypeScript types to use the new interfaces
3. **Configuration Issues**: Double-check your provider and model names

### Getting Help

If you encounter issues during migration:

1. Check the [examples](examples/) directory for working code
2. Review the [API documentation](docs/)
3. Open an issue on GitHub

## Rollback Plan

If you need to rollback temporarily:

1. Reinstall LangChain dependencies
2. Revert your code changes
3. Use the previous version of HyperAgent

However, we recommend completing the migration for the best experience.
