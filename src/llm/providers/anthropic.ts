import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  HyperAgentLLM,
  HyperAgentMessage,
  HyperAgentContentPart,
  HyperAgentStructuredResult,
  HyperAgentCapabilities,
  StructuredOutputRequest,
} from "../types";
import { convertToAnthropicMessages } from "../utils/message-converter";
import {
  convertActionsToAnthropicTools,
  convertToAnthropicTool,
  createAnthropicToolChoice,
} from "../utils/schema-converter";
import { sanitizeProviderOptions } from "../utils/provider-options";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/index";
import { getDebugOptions } from "@/debug/options";
import { formatUnknownError } from "@/utils";

const ENV_STRUCTURED_SCHEMA_DEBUG =
  process.env.HYPERAGENT_DEBUG_STRUCTURED_SCHEMA === "1" ||
  process.env.HYPERAGENT_DEBUG_STRUCTURED_SCHEMA === "true";

const RESERVED_ANTHROPIC_PROVIDER_OPTION_KEYS = new Set([
  "model",
  "messages",
  "system",
  "temperature",
  "max_tokens",
  "tools",
  "tool_choice",
]);
const MAX_ANTHROPIC_DIAGNOSTIC_CHARS = 300;

function shouldDebugStructuredSchema(): boolean {
  const opts = getDebugOptions();
  if (opts.enabled && typeof opts.structuredSchema === "boolean") {
    return opts.structuredSchema;
  }
  return ENV_STRUCTURED_SCHEMA_DEBUG;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatAnthropicDiagnostic(value: unknown): string {
  const normalized = Array.from(formatUnknownError(value), (char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code < 32) || code === 127 ? " " : char;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = normalized.length > 0 ? normalized : "unknown error";
  if (fallback.length <= MAX_ANTHROPIC_DIAGNOSTIC_CHARS) {
    return fallback;
  }
  return `${fallback.slice(
    0,
    MAX_ANTHROPIC_DIAGNOSTIC_CHARS
  )}... [truncated ${fallback.length - MAX_ANTHROPIC_DIAGNOSTIC_CHARS} chars]`;
}

function safeReadOptionalRecordField(
  source: Record<string, unknown>,
  key: string
): unknown {
  try {
    return source[key];
  } catch {
    return undefined;
  }
}

function safeReadRequiredRecordField(
  source: Record<string, unknown>,
  key: string,
  fieldLabel: string
): unknown {
  try {
    return source[key];
  } catch (error) {
    throw new Error(
      `[LLM][Anthropic] Invalid response payload: failed to read ${fieldLabel} (${formatAnthropicDiagnostic(
        error
      )})`
    );
  }
}

function extractAnthropicContentBlocks(response: unknown): unknown[] {
  if (!isRecord(response)) {
    throw new Error("[LLM][Anthropic] Invalid response payload: response must be an object");
  }
  const content = safeReadRequiredRecordField(response, "content", "content");
  if (!Array.isArray(content)) {
    throw new Error("[LLM][Anthropic] Invalid response payload: content must be an array");
  }
  try {
    return Array.from(content);
  } catch (error) {
    throw new Error(
      `[LLM][Anthropic] Invalid response payload: failed to iterate content (${formatAnthropicDiagnostic(
        error
      )})`
    );
  }
}

function findAnthropicToolUseBlock(contentBlocks: unknown[]): Record<string, unknown> | undefined {
  return contentBlocks.find(
    (block) =>
      isRecord(block) &&
      safeReadOptionalRecordField(block, "type") === "tool_use"
  ) as Record<string, unknown> | undefined;
}

function safeReadAnthropicUsageTokens(
  response: unknown,
  key: "input_tokens" | "output_tokens"
): number | undefined {
  if (!isRecord(response)) {
    return undefined;
  }
  const usage = safeReadOptionalRecordField(response, "usage");
  if (!isRecord(usage)) {
    return undefined;
  }
  const value = safeReadOptionalRecordField(usage, key);
  return typeof value === "number" ? value : undefined;
}

function stringifyRawPayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return formatUnknownError(value);
}

function safeDebugStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return formatUnknownError(value);
  }
}

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
    content: string | HyperAgentContentPart[];
    toolCalls?: Array<{ id?: string; name: string; arguments: unknown }>;
    usage?: { inputTokens?: number; outputTokens?: number };
  }> {
    const { messages: anthropicMessages, system } =
      convertToAnthropicMessages(messages);
    const providerOptions = sanitizeProviderOptions(
      options?.providerOptions,
      RESERVED_ANTHROPIC_PROVIDER_OPTION_KEYS
    );

    const response = await this.client.messages.create({
      model: this.model,
      messages: anthropicMessages as any,
      system,
      temperature: options?.temperature ?? this.temperature,
      max_tokens: options?.maxTokens ?? this.maxTokens,
      ...providerOptions,
    });

    const contentBlocks = extractAnthropicContentBlocks(response);
    const textParts = contentBlocks
      .filter(
        (block) =>
          isRecord(block) &&
          safeReadOptionalRecordField(block, "type") === "text"
      )
      .map((block) =>
        isRecord(block)
          ? safeReadOptionalRecordField(block, "text")
          : undefined
      )
      .filter((value): value is string => typeof value === "string");
    const content = textParts.join("\n\n");
    if (content.length === 0) {
      throw new Error("No text response from Anthropic");
    }

    return {
      role: "assistant",
      content,
      usage: {
        inputTokens: safeReadAnthropicUsageTokens(response, "input_tokens"),
        outputTokens: safeReadAnthropicUsageTokens(response, "output_tokens"),
      },
    };
  }

  async invokeStructured<TSchema extends z.ZodTypeAny>(
    request: StructuredOutputRequest<TSchema>,
    messages: HyperAgentMessage[]
  ): Promise<HyperAgentStructuredResult<TSchema>> {
    const { messages: anthropicMessages, system } =
      convertToAnthropicMessages(messages);

    // If actions are provided, use the agent-style tool calling path
    if (request.actions && request.actions.length > 0) {
      return await this.invokeStructuredViaTools(
        request,
        anthropicMessages,
        system
      );
    }

    // Otherwise, use simple tool calling for arbitrary schemas
    return await this.invokeStructuredViaSimpleTool(
      request,
      anthropicMessages,
      system
    );
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

  private async invokeStructuredViaTools<TSchema extends z.ZodTypeAny>(
    request: StructuredOutputRequest<TSchema>,
    messages: MessageParam[],
    system?: string
  ): Promise<HyperAgentStructuredResult<TSchema>> {
    if (!request.actions || request.actions.length === 0) {
      throw new Error(
        "Anthropic client requires at least one action definition"
      );
    }

    const tools = convertActionsToAnthropicTools(request.actions);
    const providerOptions = sanitizeProviderOptions(
      request.options?.providerOptions,
      RESERVED_ANTHROPIC_PROVIDER_OPTION_KEYS
    );

    const toolChoice =
      tools.length === 1
        ? { type: "tool", name: tools[0]!.name }
        : { type: "any", disable_parallel_tool_use: true };

    const response = await this.client.messages.create({
      model: this.model,
      messages,
      ...(system ? { system } : {}),
      temperature: request.options?.temperature ?? this.temperature,
      max_tokens: request.options?.maxTokens ?? this.maxTokens,
      tools: tools as any,
      tool_choice: toolChoice as any,
      ...providerOptions,
    });

    const responseContent = extractAnthropicContentBlocks(response);
    const toolContent = findAnthropicToolUseBlock(responseContent);

    if (!toolContent) {
      return {
        rawText: stringifyRawPayload(responseContent),
        parsed: null,
      };
    }

    const toolName = safeReadOptionalRecordField(toolContent, "name");
    const actionDefinition = request.actions.find(
      (action) =>
        (action.toolName ?? action.type) ===
        (typeof toolName === "string" ? toolName : "")
    );
    if (!actionDefinition) {
      return {
        rawText: stringifyRawPayload(toolContent),
        parsed: null,
      };
    }

    const inputValue = safeReadOptionalRecordField(toolContent, "input");
    const input = isRecord(inputValue) ? inputValue : {};
    const actionValue = safeReadOptionalRecordField(input, "action");
    const actionInput = isRecord(actionValue) ? actionValue : {};
    const paramsValue = safeReadOptionalRecordField(actionInput, "params");
    const params = typeof paramsValue === "undefined" ? {} : paramsValue;
    const thoughts = safeReadOptionalRecordField(input, "thoughts");
    const memory = safeReadOptionalRecordField(input, "memory");
    let validatedParams: z.infer<typeof actionDefinition.actionParams>;
    try {
      validatedParams = actionDefinition.actionParams.parse(params);
    } catch (error) {
      console.warn(
        `[LLM][Anthropic] Failed to validate params for action ${actionDefinition.type}: ${formatUnknownError(error)}`
      );
      return {
        rawText: stringifyRawPayload(toolContent),
        parsed: null,
      };
    }

    const structuredOutput = {
      thoughts,
      memory,
      action: {
        type: actionDefinition.type,
        params: validatedParams,
      },
    };

    try {
      const validated = request.schema.parse(structuredOutput);
      return {
        rawText: stringifyRawPayload(toolContent),
        parsed: validated,
      };
    } catch (error) {
      console.warn(
        `[LLM][Anthropic] Failed to validate structured output against schema: ${formatUnknownError(error)}`
      );
      return {
        rawText: stringifyRawPayload(toolContent),
        parsed: null,
      };
    }
  }

  /**
   * Structured output for simple schemas (non-agent use cases like examineDom)
   * Uses the original simple tool approach with "result" wrapper
   */
  private async invokeStructuredViaSimpleTool<TSchema extends z.ZodTypeAny>(
    request: StructuredOutputRequest<TSchema>,
    messages: MessageParam[],
    system?: string
  ): Promise<HyperAgentStructuredResult<TSchema>> {
    const tool = convertToAnthropicTool(request.schema);
    const toolChoice = createAnthropicToolChoice("structured_output");

    if (shouldDebugStructuredSchema()) {
      console.log(
        "[LLM][Anthropic] Simple structured output tool:",
        safeDebugStringify(tool)
      );
    }

    const response = await this.client.messages.create({
      model: this.model,
      messages,
      ...(system ? { system } : {}),
      temperature: request.options?.temperature ?? this.temperature,
      max_tokens: request.options?.maxTokens ?? this.maxTokens,
      tools: [tool as any],
      tool_choice: toolChoice as any,
      ...sanitizeProviderOptions(
        request.options?.providerOptions,
        RESERVED_ANTHROPIC_PROVIDER_OPTION_KEYS
      ),
    });

    const responseContent = extractAnthropicContentBlocks(response);
    const content = findAnthropicToolUseBlock(responseContent);
    if (!content) {
      return {
        rawText: "",
        parsed: null,
      };
    }

    const input = safeReadOptionalRecordField(content, "input");
    if (!isRecord(input)) {
      return {
        rawText: stringifyRawPayload(input),
        parsed: null,
      };
    }

    try {
      const validated = request.schema.parse(
        safeReadOptionalRecordField(input, "result")
      );
      return {
        rawText: stringifyRawPayload(input),
        parsed: validated,
      };
    } catch {
      return {
        rawText: stringifyRawPayload(input),
        parsed: null,
      };
    }
  }
}

export function createAnthropicClient(
  config: AnthropicClientConfig
): AnthropicClient {
  return new AnthropicClient(config);
}
