import OpenAI from "openai";
import { z } from "zod";
import {
  HyperAgentLLM,
  HyperAgentMessage,
  HyperAgentContentPart,
  HyperAgentStructuredResult,
  HyperAgentCapabilities,
  StructuredOutputRequest,
} from "../types";
import { convertToOpenAIMessages } from "../utils/message-converter";
import { convertToOpenAIJsonSchema } from "../utils/schema-converter";
import { normalizeOpenAICompatibleContent } from "../utils/openai-content";
import { normalizeOpenAIToolCalls } from "../utils/openai-tool-calls";
import { sanitizeProviderOptions } from "../utils/provider-options";
import { parseStructuredResponse } from "../utils/structured-response";
import { getDebugOptions } from "@/debug/options";
import { formatUnknownError } from "@/utils";

const ENV_STRUCTURED_SCHEMA_DEBUG =
  process.env.HYPERAGENT_DEBUG_STRUCTURED_SCHEMA === "1" ||
  process.env.HYPERAGENT_DEBUG_STRUCTURED_SCHEMA === "true";

const RESERVED_OPENAI_PROVIDER_OPTION_KEYS = new Set([
  "model",
  "messages",
  "temperature",
  "max_tokens",
  "maxTokens",
  "response_format",
]);
const MAX_PROVIDER_RESPONSE_DIAGNOSTIC_CHARS = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatProviderResponseDiagnostic(value: unknown): string {
  const normalized = Array.from(formatUnknownError(value), (char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code < 32) || code === 127 ? " " : char;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = normalized.length > 0 ? normalized : "unknown error";
  if (fallback.length <= MAX_PROVIDER_RESPONSE_DIAGNOSTIC_CHARS) {
    return fallback;
  }
  return `${fallback.slice(
    0,
    MAX_PROVIDER_RESPONSE_DIAGNOSTIC_CHARS
  )}... [truncated ${fallback.length - MAX_PROVIDER_RESPONSE_DIAGNOSTIC_CHARS} chars]`;
}

function safeReadRecordField(
  source: Record<string, unknown>,
  key: string,
  fieldLabel: string,
  providerLabel: string
): unknown {
  try {
    return source[key];
  } catch (error) {
    throw new Error(
      `[LLM][${providerLabel}] Invalid completion payload: failed to read ${fieldLabel} (${formatProviderResponseDiagnostic(
        error
      )})`
    );
  }
}

function extractMessageFromCompletionResponse(
  response: unknown,
  providerLabel: string
): Record<string, unknown> {
  if (!isRecord(response)) {
    throw new Error(`[LLM][${providerLabel}] Invalid completion payload: response must be an object`);
  }
  const choices = safeReadRecordField(response, "choices", "choices", providerLabel);
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error(`No response from ${providerLabel}`);
  }
  const firstChoice = choices[0];
  if (!isRecord(firstChoice)) {
    throw new Error(`[LLM][${providerLabel}] Invalid completion payload: first choice is not an object`);
  }
  const message = safeReadRecordField(
    firstChoice,
    "message",
    "choice.message",
    providerLabel
  );
  if (!isRecord(message)) {
    throw new Error(`[LLM][${providerLabel}] Invalid completion payload: choice.message is not an object`);
  }
  return message;
}

function safeReadUsageTokens(
  response: unknown,
  field: "prompt_tokens" | "completion_tokens"
): number | undefined {
  if (!isRecord(response)) {
    return undefined;
  }
  let usage: unknown;
  try {
    usage = response.usage;
  } catch {
    return undefined;
  }
  if (!isRecord(usage)) {
    return undefined;
  }
  try {
    const value = usage[field];
    return typeof value === "number" ? value : undefined;
  } catch {
    return undefined;
  }
}

function shouldDebugStructuredSchema(): boolean {
  const opts = getDebugOptions();
  if (opts.enabled && typeof opts.structuredSchema === "boolean") {
    return opts.structuredSchema;
  }
  return ENV_STRUCTURED_SCHEMA_DEBUG;
}

function safeDebugStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return formatUnknownError(value);
  }
}

export interface OpenAIClientConfig {
  apiKey?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  baseURL?: string;
}

export class OpenAIClient implements HyperAgentLLM {
  private client: OpenAI;
  private model: string;
  private temperature: number;
  private maxTokens?: number;

  constructor(config: OpenAIClientConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey || process.env.OPENAI_API_KEY,
      baseURL: config.baseURL,
    });
    this.model = config.model;
    this.temperature = config.temperature ?? 0;
    this.maxTokens = config.maxTokens;
  }

  async invoke(
    messages: HyperAgentMessage[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      providerOptions?: Record<string, unknown>;
    }
  ): Promise<{
    role: "assistant";
    content: string | HyperAgentContentPart[];
    toolCalls?: Array<{ id?: string; name: string; arguments: unknown }>;
    usage?: { inputTokens?: number; outputTokens?: number };
  }> {
    const openAIMessages = convertToOpenAIMessages(messages);
    const providerOptions = sanitizeProviderOptions(
      options?.providerOptions,
      RESERVED_OPENAI_PROVIDER_OPTION_KEYS
    );

    // GPT-5 only supports temperature=1 (default), so omit temperature for this model
    const temperature = options?.temperature ?? this.temperature;
    const shouldIncludeTemperature =
      !this.model.startsWith("gpt-5") || temperature === 1;

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: openAIMessages as any,
      ...(shouldIncludeTemperature ? { temperature } : {}),
      max_tokens: options?.maxTokens ?? this.maxTokens,
      ...providerOptions,
    });

    const message = extractMessageFromCompletionResponse(response, "OpenAI");
    const content = safeReadRecordField(
      message,
      "content",
      "choice.message.content",
      "OpenAI"
    );
    const toolCalls = normalizeOpenAIToolCalls(
      safeReadRecordField(
        message,
        "tool_calls",
        "choice.message.tool_calls",
        "OpenAI"
      )
    );

    return {
      role: "assistant",
      content: normalizeOpenAICompatibleContent(content),
      toolCalls,
      usage: {
        inputTokens: safeReadUsageTokens(response, "prompt_tokens"),
        outputTokens: safeReadUsageTokens(response, "completion_tokens"),
      },
    };
  }

  async invokeStructured<TSchema extends z.ZodTypeAny>(
    request: StructuredOutputRequest<TSchema>,
    messages: HyperAgentMessage[]
  ): Promise<HyperAgentStructuredResult<TSchema>> {
    const openAIMessages = convertToOpenAIMessages(messages);
    const providerOptions = sanitizeProviderOptions(
      request.options?.providerOptions,
      RESERVED_OPENAI_PROVIDER_OPTION_KEYS
    );
    const responseFormat = convertToOpenAIJsonSchema(request.schema);
    if (shouldDebugStructuredSchema()) {
      const schemaPayload =
        (responseFormat as { json_schema?: { schema?: unknown } }).json_schema
          ?.schema ?? responseFormat;
      console.log(
        "[LLM][OpenAI] Structured output schema:",
        safeDebugStringify(schemaPayload)
      );
    }

    // GPT-5 only supports temperature=1 (default), so omit temperature for this model
    const temperature = request.options?.temperature ?? this.temperature;
    const shouldIncludeTemperature =
      !this.model.startsWith("gpt-5") || temperature === 1;

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: openAIMessages as any,
      ...(shouldIncludeTemperature ? { temperature } : {}),
      max_tokens: request.options?.maxTokens ?? this.maxTokens,
      response_format: responseFormat as any,
      ...providerOptions,
    });

    const message = extractMessageFromCompletionResponse(response, "OpenAI");
    const content = safeReadRecordField(
      message,
      "content",
      "choice.message.content",
      "OpenAI"
    );
    return parseStructuredResponse(content, request.schema);
  }

  getProviderId(): string {
    return "openai";
  }

  getModelId(): string {
    return this.model;
  }

  getCapabilities(): HyperAgentCapabilities {
    return {
      multimodal: true,
      toolCalling: true,
      jsonMode: true,
    };
  }
}

export function createOpenAIClient(config: OpenAIClientConfig): OpenAIClient {
  return new OpenAIClient(config);
}
