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
import { convertToOpenAIJsonSchema } from "../utils/schema-converter";
import { normalizeOpenAIToolCalls } from "../utils/openai-tool-calls";
import { parseJsonMaybe } from "../utils/safe-json";
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

function convertFromDeepSeekContent(
  content: unknown
): string | HyperAgentContentPart[] {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((part: any) => {
      if (part.type === "text") {
        return { type: "text", text: part.text };
      }
      if (part.type === "image_url") {
        return {
          type: "image",
          url: part.image_url?.url ?? "",
          mimeType: "image/png",
        };
      }
      if (part.type === "tool_call") {
        return {
          type: "tool_call",
          toolName: part.function?.name ?? "unknown-tool",
          arguments: parseJsonMaybe(part.function?.arguments),
        };
      }
      return { type: "text", text: formatUnknownError(part) };
    });
  }

  if (content == null) {
    return "";
  }
  return String(content);
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

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: openAIMessages as any,
      temperature: options?.temperature ?? this.temperature,
      max_tokens: options?.maxTokens ?? this.maxTokens,
      ...options?.providerOptions,
    });

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("No response from DeepSeek");
    }

    const content = convertFromDeepSeekContent(choice.message.content);
    const toolCalls = normalizeOpenAIToolCalls(choice.message.tool_calls);

    return {
      role: "assistant",
      content: content,
      toolCalls: toolCalls,
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

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: openAIMessages as any,
      temperature: request.options?.temperature ?? this.temperature,
      max_tokens: request.options?.maxTokens ?? this.maxTokens,
      response_format: responseFormat as any,
      ...request.options?.providerOptions,
    });

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("No response from DeepSeek");
    }

    const content = choice.message.content;
    return parseStructuredResponse(content, request.schema);
  }
}

export function createDeepSeekClient(
  config: DeepSeekClientConfig
): DeepSeekClient {
  return new DeepSeekClient(config);
}
