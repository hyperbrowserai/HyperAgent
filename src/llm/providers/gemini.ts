import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import {
  HyperAgentLLM,
  HyperAgentMessage,
  HyperAgentContentPart,
  HyperAgentStructuredResult,
  HyperAgentCapabilities,
  StructuredOutputRequest,
} from "../types";
import { convertToGeminiMessages } from "../utils/message-converter";
import { convertToGeminiResponseSchema } from "../utils/schema-converter";
import { sanitizeProviderOptions } from "../utils/provider-options";
import { parseStructuredResponse } from "../utils/structured-response";
import { formatUnknownError } from "@/utils";

const RESERVED_GEMINI_CONFIG_OPTION_KEYS = new Set([
  "temperature",
  "maxOutputTokens",
  "systemInstruction",
  "responseMimeType",
  "responseSchema",
]);
const MAX_GEMINI_DIAGNOSTIC_CHARS = 300;

function formatGeminiDiagnostic(value: unknown): string {
  const normalized = Array.from(formatUnknownError(value), (char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code < 32) || code === 127 ? " " : char;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = normalized.length > 0 ? normalized : "unknown error";
  if (fallback.length <= MAX_GEMINI_DIAGNOSTIC_CHARS) {
    return fallback;
  }
  return `${fallback.slice(
    0,
    MAX_GEMINI_DIAGNOSTIC_CHARS
  )}... [truncated ${fallback.length - MAX_GEMINI_DIAGNOSTIC_CHARS} chars]`;
}

function safeReadGeminiResponseText(response: unknown): unknown {
  try {
    return (response as { text?: unknown }).text;
  } catch (error) {
    return `[Unreadable Gemini response text: ${formatGeminiDiagnostic(error)}]`;
  }
}

function safeReadGeminiUsageTokens(
  response: unknown,
  key: "promptTokenCount" | "candidatesTokenCount"
): number | undefined {
  let usageMetadata: unknown;
  try {
    usageMetadata = (response as { usageMetadata?: unknown }).usageMetadata;
  } catch {
    return undefined;
  }
  if (!usageMetadata || typeof usageMetadata !== "object") {
    return undefined;
  }
  try {
    const value = (usageMetadata as Record<string, unknown>)[key];
    return typeof value === "number" ? value : undefined;
  } catch {
    return undefined;
  }
}

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

  private buildGeminiConfig(
    options?: {
      temperature?: number;
      maxTokens?: number;
      providerOptions?: Record<string, unknown>;
    },
    systemInstruction?: string
  ): Record<string, unknown> {
    const resolvedMaxTokens = options?.maxTokens ?? this.maxTokens;
    const providerOptions = sanitizeProviderOptions(
      options?.providerOptions,
      RESERVED_GEMINI_CONFIG_OPTION_KEYS
    );

    return {
      ...(providerOptions ?? {}),
      temperature: options?.temperature ?? this.temperature,
      ...(typeof resolvedMaxTokens === "number"
        ? { maxOutputTokens: resolvedMaxTokens }
        : {}),
      ...(systemInstruction ? { systemInstruction } : {}),
    };
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
    const { messages: geminiMessages, systemInstruction } =
      convertToGeminiMessages(messages);

    const response = await this.client.models.generateContent({
      model: this.model,
      contents: geminiMessages as any,
      config: this.buildGeminiConfig(options, systemInstruction),
    });

    const text = safeReadGeminiResponseText(response);
    if (!text) {
      throw new Error("No text response from Gemini");
    }
    if (typeof text !== "string") {
      throw new Error(
        `[LLM][Gemini] Invalid response payload: expected text string, received ${formatGeminiDiagnostic(
          text
        )}`
      );
    }

    return {
      role: "assistant",
      content: text,
      usage: {
        inputTokens: safeReadGeminiUsageTokens(response, "promptTokenCount"),
        outputTokens: safeReadGeminiUsageTokens(
          response,
          "candidatesTokenCount"
        ),
      },
    };
  }

  async invokeStructured<TSchema extends z.ZodTypeAny>(
    request: StructuredOutputRequest<TSchema>,
    messages: HyperAgentMessage[]
  ): Promise<HyperAgentStructuredResult<TSchema>> {
    const { messages: geminiMessages, systemInstruction } =
      convertToGeminiMessages(messages);
    const responseSchema = convertToGeminiResponseSchema(request.schema);

    const response = await this.client.models.generateContent({
      model: this.model,
      contents: geminiMessages as any,
      config: {
        ...this.buildGeminiConfig(request.options, systemInstruction),
        responseMimeType: "application/json",
        responseSchema: responseSchema,
      },
    });

    const text = safeReadGeminiResponseText(response);
    return parseStructuredResponse(text, request.schema);
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
