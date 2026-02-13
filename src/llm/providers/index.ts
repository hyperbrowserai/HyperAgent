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

function normalizeProvider(provider: unknown): LLMProvider {
  if (typeof provider !== "string") {
    throw new Error("LLM provider must be a string");
  }

  const normalized = provider.trim().toLowerCase();
  if (
    normalized === "openai" ||
    normalized === "anthropic" ||
    normalized === "gemini" ||
    normalized === "deepseek"
  ) {
    return normalized;
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

function normalizeModel(model: unknown): string {
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new Error("LLM model must be a non-empty string");
  }
  return model.trim();
}

function normalizeTemperature(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function normalizeMaxTokens(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizeBaseURL(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid LLM baseURL: ${trimmed}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid LLM baseURL protocol: ${parsed.protocol}`);
  }

  return parsed.toString().replace(/\/$/, "");
}

function normalizeApiKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function createLLMClient(config: LLMConfig): HyperAgentLLM {
  const provider = normalizeProvider(config.provider);
  const model = normalizeModel(config.model);
  const temperature = normalizeTemperature(config.temperature);
  const maxTokens = normalizeMaxTokens(config.maxTokens);
  const baseURL = normalizeBaseURL(config.baseURL);
  const apiKey = normalizeApiKey(config.apiKey);

  switch (provider) {
    case "openai":
      return createOpenAIClient({
        apiKey,
        model,
        temperature,
        maxTokens,
        baseURL,
      });

    case "anthropic":
      return createAnthropicClient({
        apiKey,
        model,
        temperature,
        maxTokens,
      });

    case "gemini":
      return createGeminiClient({
        apiKey,
        model,
        temperature,
        maxTokens,
      });

    case "deepseek":
      return createDeepSeekClient({
        apiKey,
        model,
        temperature,
        maxTokens,
        baseURL,
      });

    default:
      throw new Error(`Unsupported provider: ${provider}`);
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
