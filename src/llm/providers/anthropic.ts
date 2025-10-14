import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  HyperAgentLLM,
  HyperAgentMessage,
  HyperAgentStructuredResult,
  HyperAgentCapabilities,
  StructuredOutputRequest,
} from "../types";
import { convertToAnthropicMessages } from "../utils/message-converter";
import {
  convertToAnthropicTool,
  createAnthropicToolChoice,
} from "../utils/schema-converter";

export interface AnthropicClientConfig {
  apiKey?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export class AnthropicClient implements HyperAgentLLM {
  private client: Anthropic;
  private model: string;
  private temperature: number;
  private maxTokens: number;

  constructor(config: AnthropicClientConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY,
    });
    this.model = config.model;
    this.temperature = config.temperature ?? 0;
    this.maxTokens = config.maxTokens ?? 4096; // Anthropic requires explicit max_tokens
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
    content: string | any[];
    toolCalls?: Array<{ id?: string; name: string; arguments: unknown }>;
    usage?: { inputTokens?: number; outputTokens?: number };
  }> {
    const { messages: anthropicMessages, system } =
      convertToAnthropicMessages(messages);

    const response = await this.client.messages.create({
      model: this.model,
      messages: anthropicMessages as any,
      system,
      temperature: options?.temperature ?? this.temperature,
      max_tokens: options?.maxTokens ?? this.maxTokens,
      ...options?.providerOptions,
    });

    const content = response.content[0];
    if (!content || content.type !== "text") {
      throw new Error("No text response from Anthropic");
    }

    return {
      role: "assistant",
      content: content.text,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  async invokeStructured<TSchema extends z.ZodTypeAny>(
    request: StructuredOutputRequest<TSchema>,
    messages: HyperAgentMessage[]
  ): Promise<HyperAgentStructuredResult<TSchema>> {
    const { messages: anthropicMessages, system } =
      convertToAnthropicMessages(messages);
    const tool = convertToAnthropicTool(request.schema);
    const toolChoice = createAnthropicToolChoice("structured_output");

    const response = await this.client.messages.create({
      model: this.model,
      messages: anthropicMessages as any,
      system,
      temperature: request.options?.temperature ?? this.temperature,
      max_tokens: request.options?.maxTokens ?? this.maxTokens,
      tools: [tool as any],
      tool_choice: toolChoice as any,
      ...request.options?.providerOptions,
    });

    const content = response.content[0];
    if (!content || content.type !== "tool_use") {
      return {
        rawText: "",
        parsed: null,
      };
    }

    try {
      const input = content.input as any;
      const validated = request.schema.parse(input.result);
      return {
        rawText: JSON.stringify(input),
        parsed: validated,
      };
    } catch {
      return {
        rawText: JSON.stringify(content.input),
        parsed: null,
      };
    }
  }

  getProviderId(): string {
    return "anthropic";
  }

  getModelId(): string {
    return this.model;
  }

  getCapabilities(): HyperAgentCapabilities {
    return {
      multimodal: true,
      toolCalling: true,
      jsonMode: false, // Anthropic uses tool calling for structured output
    };
  }
}

export function createAnthropicClient(
  config: AnthropicClientConfig
): AnthropicClient {
  return new AnthropicClient(config);
}
