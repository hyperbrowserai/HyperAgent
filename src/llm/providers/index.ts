import { HyperAgentLLM } from "../types";
import { createOpenAIClient, OpenAIClientConfig } from "./openai";
import { createAnthropicClient, AnthropicClientConfig } from "./anthropic";
import { createGeminiClient, GeminiClientConfig } from "./gemini";
import { createDeepSeekClient, DeepSeekClientConfig } from "./deepseek";
import { formatUnknownError } from "@/utils";

export type LLMProvider = "openai" | "anthropic" | "gemini" | "deepseek";

export interface LLMConfig {
  provider: LLMProvider;
  apiKey?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  baseURL?: string; // For OpenAI custom endpoints
}

const MAX_MODEL_ID_CHARS = 200;
const MAX_PROVIDER_ID_CHARS = 40;
const MAX_LLM_CONFIG_DIAGNOSTIC_CHARS = 200;

function truncateLLMConfigDiagnostic(value: string): string {
  if (value.length <= MAX_LLM_CONFIG_DIAGNOSTIC_CHARS) {
    return value;
  }
  return `${value.slice(
    0,
    MAX_LLM_CONFIG_DIAGNOSTIC_CHARS
  )}... [truncated ${value.length - MAX_LLM_CONFIG_DIAGNOSTIC_CHARS} chars]`;
}

function formatLLMConfigDiagnostic(value: unknown): string {
  const normalized = Array.from(formatUnknownError(value), (char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code < 32) || code === 127 ? " " : char;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = normalized.length > 0 ? normalized : "unknown error";
  return truncateLLMConfigDiagnostic(fallback);
}

function safeReadConfigField(
  config: Record<string, unknown>,
  field: keyof LLMConfig
): unknown {
  try {
    return config[field];
  } catch (error) {
    throw new Error(
      `Invalid LLM config: failed to read "${field}" (${formatLLMConfigDiagnostic(
        error
      )})`
    );
  }
}

function normalizeProvider(provider: unknown): LLMProvider {
  if (typeof provider !== "string") {
    throw new Error("LLM provider must be a string");
  }

  const normalized = provider
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .toLowerCase();
  if (normalized.length > MAX_PROVIDER_ID_CHARS) {
    throw new Error(
      `LLM provider exceeds maximum length of ${MAX_PROVIDER_ID_CHARS} characters`
    );
  }
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
  if (typeof model !== "string") {
    throw new Error("LLM model must be a non-empty string");
  }
  const normalized = model
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
  if (normalized.length === 0) {
    throw new Error("LLM model must be a non-empty string");
  }
  if (normalized.length > MAX_MODEL_ID_CHARS) {
    throw new Error(
      `LLM model exceeds maximum length of ${MAX_MODEL_ID_CHARS} characters`
    );
  }
  return normalized;
}

function normalizeTemperature(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (value < 0 || value > 2) {
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
  if (!config || typeof config !== "object") {
    throw new Error("Invalid LLM config: config must be an object");
  }

  const configRecord = config as unknown as Record<string, unknown>;
  const provider = normalizeProvider(safeReadConfigField(configRecord, "provider"));
  const model = normalizeModel(safeReadConfigField(configRecord, "model"));
  const temperature = normalizeTemperature(
    safeReadConfigField(configRecord, "temperature")
  );
  const maxTokens = normalizeMaxTokens(safeReadConfigField(configRecord, "maxTokens"));
  const baseURL =
    provider === "openai" || provider === "deepseek"
      ? normalizeBaseURL(safeReadConfigField(configRecord, "baseURL"))
      : undefined;
  const apiKey = normalizeApiKey(safeReadConfigField(configRecord, "apiKey"));

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
