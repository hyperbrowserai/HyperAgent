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

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("No response from OpenAI");
    }

    const message = choice.message;
    const toolCalls = normalizeOpenAIToolCalls(message.tool_calls);

    return {
      role: "assistant",
      content: normalizeOpenAICompatibleContent(message.content),
      toolCalls,
      usage: {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
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

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("No response from OpenAI");
    }

    const content = choice.message.content;
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
