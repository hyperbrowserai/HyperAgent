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
import { z } from "zod";

export interface DeepSeekClientConfig {
  apiKey?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  baseURL?: string;
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

    const content = choice.message.content || "";
    const toolCalls = choice.message.tool_calls?.map((tc) => {
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

    const content = choice.message.content || "";
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
}

export function createDeepSeekClient(
  config: DeepSeekClientConfig
): DeepSeekClient {
  return new DeepSeekClient(config);
}
