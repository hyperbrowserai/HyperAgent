import OpenAI from "openai";
import type {
  Response as OpenAIResponse,
  ResponseFunctionToolCall,
  ResponseInput,
  ResponseOutputItem,
  ResponseTextConfig,
} from "openai/resources/responses/responses";
import { z } from "zod";
import {
  HyperAgentLLM,
  HyperAgentMessage,
  HyperAgentStructuredResult,
  HyperAgentCapabilities,
  StructuredOutputRequest,
  HyperAgentContentPart,
} from "../types";
import { convertToOpenAIJsonSchema } from "../utils/schema-converter";

export interface OpenAIClientConfig {
  apiKey?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  baseURL?: string;
}

const DEFAULT_IMAGE_DETAIL = "auto" as const;

/** @internal */
export function convertMessagesToResponseInput(
  messages: HyperAgentMessage[]
): ResponseInput {
  const input: ResponseInput = [];

  for (const message of messages) {
    if (message.role === "tool") {
      const toolOutput =
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content);

      input.push({
        type: "function_call_output",
        call_id: message.toolCallId ?? message.toolName,
        output: toolOutput,
      });
      continue;
    }

    const contentArray =
      typeof message.content === "string"
        ? [createTextContentPart(message.content)]
        : message.content
            .map((part) => convertContentPart(part))
            .filter((part): part is NonNullable<typeof part> => part !== null);

    if (message.role === "assistant") {
      if (message.toolCalls) {
        for (const toolCall of message.toolCalls) {
          const functionCall: ResponseFunctionToolCall = {
            type: "function_call",
            call_id: toolCall.id ?? toolCall.name,
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments ?? {}),
          };

          if (toolCall.id) {
            functionCall.id = toolCall.id;
          }

          input.push(functionCall);
        }
      }

      if (contentArray.length === 0) {
        continue;
      }
    }

    input.push({
      type: "message",
      role: message.role,
      content: contentArray,
    });
  }

  return input;
}

function convertContentPart(part: HyperAgentContentPart):
  | {
      type: "input_text";
      text: string;
    }
  | {
      type: "input_image";
      image_url: string;
      detail: "low" | "high" | "auto";
    }
  | null {
  if (part.type === "text") {
    return { type: "input_text", text: part.text };
  }

  if (part.type === "image") {
    return {
      type: "input_image",
      image_url: part.url,
      detail: DEFAULT_IMAGE_DETAIL,
    };
  }

  // Tool calls are represented as dedicated ResponseInput items, skip them here.
  return null;
}

function createTextContentPart(text: string): {
  type: "input_text";
  text: string;
} {
  return { type: "input_text", text };
}

function convertOutputMessagePart(
  part: Record<string, unknown>
): HyperAgentContentPart | HyperAgentContentPart[] | null {
  const partType = typeof part.type === "string" ? part.type : undefined;

  if (partType === "output_text") {
    return { type: "text", text: String(part.text ?? "") };
  }

  if (partType === "refusal") {
    return { type: "text", text: String(part.refusal ?? "") };
  }

  if (partType === "output_image") {
    const imagePart = extractImagePart(part);
    if (imagePart) {
      return imagePart;
    }
  }

  if (partType === "output_audio") {
    const transcript =
      typeof part.transcript === "string" ? part.transcript : undefined;
    if (transcript) {
      return { type: "text", text: transcript };
    }
  }

  return null;
}

function extractImagePart(
  part: Record<string, unknown>
): HyperAgentContentPart | null {
  const imageUrlBlock = part.image_url as Record<string, unknown> | undefined;
  if (imageUrlBlock && typeof imageUrlBlock.url === "string") {
    const mimeType =
      typeof imageUrlBlock.mime_type === "string"
        ? imageUrlBlock.mime_type
        : "image/png";
    return {
      type: "image",
      url: imageUrlBlock.url,
      mimeType,
    };
  }

  const base64Data = typeof part.base64 === "string" ? part.base64 : undefined;
  if (base64Data) {
    const mimeType =
      typeof part.mime_type === "string" ? part.mime_type : "image/png";
    return {
      type: "image",
      url: `data:${mimeType};base64,${base64Data}`,
      mimeType,
    };
  }

  return null;
}

function convertImageGenerationCall(
  item: ResponseOutputItem.ImageGenerationCall
): HyperAgentContentPart | null {
  if (!item.result) {
    return null;
  }

  return {
    type: "image",
    url: `data:image/png;base64,${item.result}`,
    mimeType: "image/png",
  };
}

function normalizeResponseFormat(
  value: unknown
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const format = value as Record<string, unknown>;

  if (format.type === "json_schema" && typeof format.json_schema === "object") {
    const schemaBlock = format.json_schema as Record<string, unknown>;
    return {
      type: "json_schema",
      json_schema: {
        name:
          typeof schemaBlock.name === "string"
            ? schemaBlock.name
            : "structured_output",
        schema: schemaBlock.schema ?? {},
        strict:
          typeof schemaBlock.strict === "boolean" ? schemaBlock.strict : true,
        description:
          typeof schemaBlock.description === "string"
            ? schemaBlock.description
            : undefined,
        ...schemaBlock,
      },
    };
  }

  return format;
}

/** @internal */
export function normalizeResponsesProviderOptions(
  providerOptions?: Record<string, unknown>
): Record<string, unknown> {
  if (!providerOptions) {
    return {};
  }

  const normalized: Record<string, unknown> = { ...providerOptions };

  let textOptions: Record<string, unknown> | undefined;
  if (typeof normalized.text === "object" && normalized.text !== null) {
    textOptions = { ...(normalized.text as Record<string, unknown>) };
  }

  delete normalized.text;

  if ("response_format" in normalized) {
    const formatValue = (normalized as Record<string, unknown>).response_format;
    delete normalized.response_format;
    const resolvedFormat = normalizeResponseFormat(formatValue);
    if (resolvedFormat) {
      textOptions = { ...(textOptions ?? {}), format: resolvedFormat };
    }
  }

  if (textOptions) {
    normalized.text = textOptions;
  }

  if (
    "max_tokens" in normalized &&
    normalized.max_output_tokens === undefined
  ) {
    normalized.max_output_tokens = normalized.max_tokens;
    delete normalized.max_tokens;
  }

  return normalized;
}

/** @internal */
export function parseResponseOutput(response: OpenAIResponse): {
  contentParts: HyperAgentContentPart[];
  toolCalls: Array<{ id?: string; name: string; arguments: unknown }>;
} {
  const contentParts: HyperAgentContentPart[] = [];
  const toolCalls: Array<{ id?: string; name: string; arguments: unknown }> =
    [];

  const outputItems = (response.output ?? []) as ResponseOutputItem[];

  for (const item of outputItems) {
    if (item.type === "message") {
      const contentList = (item.content ?? []) as unknown as Array<
        Record<string, unknown>
      >;

      for (const part of contentList) {
        const converted = convertOutputMessagePart(part);
        if (!converted) {
          continue;
        }

        if (Array.isArray(converted)) {
          contentParts.push(...converted);
        } else {
          contentParts.push(converted);
        }
      }
      continue;
    }

    if (item.type === "function_call") {
      const parsedArgs =
        typeof item.arguments === "string"
          ? safeJsonParse(item.arguments)
          : item.arguments;

      toolCalls.push({
        id: item.id ?? item.call_id,
        name: item.name,
        arguments: parsedArgs,
      });
      continue;
    }

    if (item.type === "image_generation_call") {
      const imagePart = convertImageGenerationCall(
        item as ResponseOutputItem.ImageGenerationCall
      );
      if (imagePart) {
        contentParts.push(imagePart);
      }
    }
  }

  if (contentParts.length === 0 && typeof response.output_text === "string") {
    contentParts.push({ type: "text", text: response.output_text });
  }

  return { contentParts, toolCalls };
}

function collapseContent(
  parts: HyperAgentContentPart[]
): string | HyperAgentContentPart[] {
  if (parts.length === 0) {
    return "";
  }

  const allText = parts.every((part) => part.type === "text");
  if (allText) {
    return parts.map((part) => (part as { text: string }).text).join("");
  }

  return parts;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
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
    const input = convertMessagesToResponseInput(messages);
    const providerOptions = normalizeResponsesProviderOptions(
      options?.providerOptions
    );

    const requestPayload: Record<string, unknown> & {
      model: string;
      input: ResponseInput;
    } = {
      model: this.model,
      input,
    };

    const temperature = options?.temperature ?? this.temperature;
    if (typeof temperature === "number") {
      requestPayload.temperature = temperature;
    }

    const maxTokens = options?.maxTokens ?? this.maxTokens;
    if (typeof maxTokens === "number") {
      requestPayload.max_output_tokens = maxTokens;
    }

    Object.assign(requestPayload, providerOptions);

    const response = (await this.client.responses.create(
      requestPayload as any
    )) as OpenAIResponse;

    const { contentParts, toolCalls } = parseResponseOutput(response);

    return {
      role: "assistant",
      content: collapseContent(contentParts),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          }
        : undefined,
    };
  }

  async invokeStructured<TSchema extends z.ZodTypeAny>(
    request: StructuredOutputRequest<TSchema>,
    messages: HyperAgentMessage[]
  ): Promise<HyperAgentStructuredResult<TSchema>> {
    const input = convertMessagesToResponseInput(messages);
    const providerOptions = normalizeResponsesProviderOptions(
      request.options?.providerOptions
    );

    const responseFormat = convertToOpenAIJsonSchema(request.schema);
    const normalizedFormat = normalizeResponseFormat(responseFormat);

    const requestPayload: Record<string, unknown> & {
      model: string;
      input: ResponseInput;
    } = {
      model: this.model,
      input,
    };

    const temperature = request.options?.temperature ?? this.temperature;
    if (typeof temperature === "number") {
      requestPayload.temperature = temperature;
    }

    const maxTokens = request.options?.maxTokens ?? this.maxTokens;
    if (typeof maxTokens === "number") {
      requestPayload.max_output_tokens = maxTokens;
    }

    const textOptions = providerOptions.text as
      | Record<string, unknown>
      | undefined;
    if (textOptions) {
      delete providerOptions.text;
    }

    const textPayload: Record<string, unknown> = {
      ...(textOptions ?? {}),
    };

    if (normalizedFormat) {
      textPayload.format = normalizedFormat;
    }

    if (Object.keys(textPayload).length > 0) {
      requestPayload.text = textPayload as ResponseTextConfig;
    }

    Object.assign(requestPayload, providerOptions);

    const response = (await this.client.responses.create(
      requestPayload as any
    )) as OpenAIResponse;

    const { contentParts } = parseResponseOutput(response);
    const collapsed = collapseContent(contentParts);

    let rawText = "";
    if (typeof collapsed === "string") {
      rawText = collapsed;
    } else {
      const textParts = collapsed.filter(
        (part): part is Extract<HyperAgentContentPart, { type: "text" }> =>
          part.type === "text"
      );
      rawText = textParts.map((part) => part.text).join("");
    }

    if (!rawText) {
      return { rawText: "", parsed: null };
    }

    try {
      const parsed = JSON.parse(rawText);
      const validated = request.schema.parse(parsed);
      return {
        rawText,
        parsed: validated,
      };
    } catch {
      return {
        rawText,
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
