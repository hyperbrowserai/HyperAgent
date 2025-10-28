import { HyperAgentLLM } from "../types";
import { createOpenAIClient, OpenAIClientConfig } from "./openai";
import { createAnthropicClient, AnthropicClientConfig } from "./anthropic";
import { createGeminiClient, GeminiClientConfig } from "./gemini";
import { createDeepSeekClient, DeepSeekClientConfig } from "./deepseek";

export type LLMProvider = "openai" | "anthropic" | "gemini" | "deepseek";

export interface LLMConfig {
  provider: LLMProvider;
  apiKey?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  baseURL?: string; // For OpenAI custom endpoints
}

export function createLLMClient(config: LLMConfig): HyperAgentLLM {
  switch (config.provider) {
    case "openai":
      return createOpenAIClient({
        apiKey: config.apiKey,
        model: config.model,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        baseURL: config.baseURL,
      });

    case "anthropic":
      return createAnthropicClient({
        apiKey: config.apiKey,
        model: config.model,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
      });

    case "gemini":
      return createGeminiClient({
        apiKey: config.apiKey,
        model: config.model,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
      });

    case "deepseek":
      return createDeepSeekClient({
        apiKey: config.apiKey,
        model: config.model,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        baseURL: config.baseURL,
      });

    default:
      throw new Error(`Unsupported provider: ${config.provider}`);
  }
}

// Export individual provider creators for direct use
export { createOpenAIClient } from "./openai";
export { createAnthropicClient } from "./anthropic";
export { createGeminiClient } from "./gemini";
export { createDeepSeekClient } from "./deepseek";

// Export types (use type-only export for interface)
export type { HyperAgentLLM } from "../types";

// Export utility functions
export * from "../utils/message-converter";
export * from "../utils/schema-converter";
