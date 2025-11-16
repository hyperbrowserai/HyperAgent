import OpenAI from "openai";
import { z } from "zod";
import {
  HyperAgentLLM,
  HyperAgentMessage,
  HyperAgentStructuredResult,
  HyperAgentCapabilities,
  StructuredOutputRequest,
  HyperAgentContentPart,
} from "../types";
import { convertToOpenAIMessages } from "../utils/message-converter";
import { convertToOpenAIJsonSchema } from "../utils/schema-converter";
import { getDebugOptions } from "@/debug/options";

const ENV_STRUCTURED_SCHEMA_DEBUG =
  process.env.HYPERAGENT_DEBUG_STRUCTURED_SCHEMA === "1" ||
  process.env.HYPERAGENT_DEBUG_STRUCTURED_SCHEMA === "true";

function shouldDebugStructuredSchema(): boolean {
  const opts = getDebugOptions();
  if (opts.enabled && typeof opts.structuredSchema === "boolean") {
    return opts.structuredSchema;
  }
  return ENV_STRUCTURED_SCHEMA_DEBUG;
}

export interface OpenAIClientConfig {
  apiKey?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  baseURL?: string;
}

/**
 * Convert OpenAI's content format back to HyperAgentContentPart format
 */
function convertFromOpenAIContent(
  content: any
): string | HyperAgentContentPart[] {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((part: any) => {
      if (part.type === "text") {
        return { type: "text", text: part.text };
      } else if (part.type === "image_url") {
        return {
          type: "image",
          url: part.image_url.url,
          mimeType: "image/png", // Default, could be extracted from URL if needed
        };
      } else if (part.type === "tool_call") {
        return {
          type: "tool_call",
          toolName: part.function.name,
          arguments: JSON.parse(part.function.arguments),
        };
      }
      // Fallback for unknown types
      return { type: "text", text: JSON.stringify(part) };
    });
  }

  // Fallback for unexpected content types
  return String(content);
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

    // GPT-5 only supports temperature=1 (default), so omit temperature for this model
    const temperature = options?.temperature ?? this.temperature;
    const shouldIncludeTemperature =
      !this.model.startsWith("gpt-5") || temperature === 1;

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: openAIMessages as any,
      ...(shouldIncludeTemperature ? { temperature } : {}),
      max_tokens: options?.maxTokens ?? this.maxTokens,
      ...options?.providerOptions,
    });

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("No response from OpenAI");
    }

    const message = choice.message;
    const toolCalls = message.tool_calls?.map((tc) => {
      // Handle both function and custom tool calls in OpenAI v6
      if (tc.type === "function") {
        return {
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments),
        };
      } else if (tc.type === "custom") {
        return {
          id: tc.id,
          name: tc.custom.name,
          arguments: JSON.parse(tc.custom.input),
        };
      }
      throw new Error(`Unknown tool call type: ${(tc as any).type}`);
    });

    return {
      role: "assistant",
      content: convertFromOpenAIContent(message.content),
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
    const responseFormat = convertToOpenAIJsonSchema(request.schema);
    if (shouldDebugStructuredSchema()) {
      const schemaPayload =
        (responseFormat as { json_schema?: { schema?: unknown } }).json_schema
          ?.schema ?? responseFormat;
      console.log(
        "[LLM][OpenAI] Structured output schema:",
        JSON.stringify(schemaPayload, null, 2)
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
      ...request.options?.providerOptions,
    });

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("No response from OpenAI");
    }

    const content = choice.message.content;
    if (!content || typeof content !== "string") {
      return {
        rawText: "",
        parsed: null,
      };
    }

    try {
      const parsed = JSON.parse(content);
      const validated = request.schema.parse(parsed);
      return {
        rawText: content,
        parsed: validated,
      };
    } catch {
      return {
        rawText: content,
        parsed: null,
      };
    }
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
