import OpenAI from "openai";
import {
  HyperAgentLLM,
  HyperAgentMessage,
  HyperAgentCapabilities,
  HyperAgentInvokeOptions,
  HyperAgentStructuredResult,
  StructuredOutputRequest,
  HyperAgentContentPart,
} from "../types";
import { convertToOpenAIMessages } from "../utils/message-converter";
import { normalizeOpenAICompatibleContent } from "../utils/openai-content";
import { convertToOpenAIJsonSchema } from "../utils/schema-converter";
import { normalizeOpenAIToolCalls } from "../utils/openai-tool-calls";
import { sanitizeProviderOptions } from "../utils/provider-options";
import { parseStructuredResponse } from "../utils/structured-response";
import { z } from "zod";
import { formatUnknownError } from "@/utils";

export interface DeepSeekClientConfig {
  apiKey?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  baseURL?: string;
}

const RESERVED_DEEPSEEK_PROVIDER_OPTION_KEYS = new Set([
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
  const normalized = formatUnknownError(value);
  if (normalized.length <= MAX_PROVIDER_RESPONSE_DIAGNOSTIC_CHARS) {
    return normalized;
  }
  return `${normalized.slice(
    0,
    MAX_PROVIDER_RESPONSE_DIAGNOSTIC_CHARS
  )}... [truncated ${normalized.length - MAX_PROVIDER_RESPONSE_DIAGNOSTIC_CHARS} chars]`;
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

export class DeepSeekClient implements HyperAgentLLM {
  private client: OpenAI;
  private model: string;
  private temperature: number;
  private maxTokens: number | undefined;

  constructor(config: DeepSeekClientConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey ?? process.env.DEEPSEEK_API_KEY,
      baseURL: config.baseURL ?? "https://api.deepseek.com",
    });
    this.model = config.model;
    this.temperature = config.temperature ?? 0;
    this.maxTokens = config.maxTokens;
  }

  getProviderId(): string {
    return "deepseek";
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

  async invoke(
    messages: HyperAgentMessage[],
    options?: HyperAgentInvokeOptions
  ): Promise<{
    role: "assistant";
    content: string | HyperAgentContentPart[];
    toolCalls?: Array<{ id?: string; name: string; arguments: unknown }>;
    usage?: { inputTokens?: number; outputTokens?: number };
  }> {
    const openAIMessages = convertToOpenAIMessages(messages);
    const providerOptions = sanitizeProviderOptions(
      options?.providerOptions,
      RESERVED_DEEPSEEK_PROVIDER_OPTION_KEYS
    );

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: openAIMessages as any,
      temperature: options?.temperature ?? this.temperature,
      max_tokens: options?.maxTokens ?? this.maxTokens,
      ...providerOptions,
    });

    const message = extractMessageFromCompletionResponse(response, "DeepSeek");
    const content = normalizeOpenAICompatibleContent(
      safeReadRecordField(
        message,
        "content",
        "choice.message.content",
        "DeepSeek"
      )
    );
    const toolCalls = normalizeOpenAIToolCalls(
      safeReadRecordField(
        message,
        "tool_calls",
        "choice.message.tool_calls",
        "DeepSeek"
      ),
      "DeepSeek"
    );

    return {
      role: "assistant",
      content: content,
      toolCalls: toolCalls,
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
      RESERVED_DEEPSEEK_PROVIDER_OPTION_KEYS
    );
    const responseFormat = convertToOpenAIJsonSchema(request.schema);

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: openAIMessages as any,
      temperature: request.options?.temperature ?? this.temperature,
      max_tokens: request.options?.maxTokens ?? this.maxTokens,
      response_format: responseFormat as any,
      ...providerOptions,
    });

    const message = extractMessageFromCompletionResponse(response, "DeepSeek");
    const content = safeReadRecordField(
      message,
      "content",
      "choice.message.content",
      "DeepSeek"
    );
    return parseStructuredResponse(content, request.schema);
  }
}

export function createDeepSeekClient(
  config: DeepSeekClientConfig
): DeepSeekClient {
  return new DeepSeekClient(config);
}
