import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import {
  HyperAgentLLM,
  HyperAgentMessage,
  HyperAgentStructuredResult,
  HyperAgentCapabilities,
  StructuredOutputRequest,
} from "../types";
import { convertToGeminiMessages } from "../utils/message-converter";
import { convertToGeminiResponseSchema } from "../utils/schema-converter";

export interface GeminiClientConfig {
  apiKey?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export class GeminiClient implements HyperAgentLLM {
  private client: GoogleGenAI;
  private model: string;
  private temperature: number;
  private maxTokens?: number;

  constructor(config: GeminiClientConfig) {
    this.client = new GoogleGenAI({
      apiKey:
        config.apiKey ||
        process.env.GEMINI_API_KEY ||
        process.env.GOOGLE_API_KEY,
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
    content: string | any[];
    toolCalls?: Array<{ id?: string; name: string; arguments: unknown }>;
    usage?: { inputTokens?: number; outputTokens?: number };
  }> {
    const { messages: geminiMessages } = convertToGeminiMessages(messages);

    const response = await this.client.models.generateContent({
      model: this.model,
      contents: geminiMessages as any,
    });

    const text = response.text;
    if (!text) {
      throw new Error("No text response from Gemini");
    }

    return {
      role: "assistant",
      content: text,
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount,
        outputTokens: response.usageMetadata?.candidatesTokenCount,
      },
    };
  }

  async invokeStructured<TSchema extends z.ZodTypeAny>(
    request: StructuredOutputRequest<TSchema>,
    messages: HyperAgentMessage[]
  ): Promise<HyperAgentStructuredResult<TSchema>> {
    const { messages: geminiMessages } = convertToGeminiMessages(messages);
    const responseSchema = convertToGeminiResponseSchema(request.schema);

    const response = await this.client.models.generateContent({
      model: this.model,
      contents: geminiMessages as any,
      config: {
        temperature: request.options?.temperature ?? this.temperature,
        maxOutputTokens: request.options?.maxTokens ?? this.maxTokens,
        responseMimeType: "application/json",
        responseSchema: responseSchema,
      },
    });

    const text = response.text;
    if (!text) {
      return {
        rawText: "",
        parsed: null,
      };
    }

    try {
      // Gemini returns pure JSON when using responseJsonSchema
      const parsed = JSON.parse(text);
      const validated = request.schema.parse(parsed);
      return {
        rawText: text,
        parsed: validated,
      };
    } catch {
      return {
        rawText: text,
        parsed: null,
      };
    }
  }

  getProviderId(): string {
    return "gemini";
  }

  getModelId(): string {
    return this.model;
  }

  getCapabilities(): HyperAgentCapabilities {
    return {
      multimodal: true,
      toolCalling: false, // Gemini has limited tool calling support
      jsonMode: true,
    };
  }
}

export function createGeminiClient(config: GeminiClientConfig): GeminiClient {
  return new GeminiClient(config);
}
