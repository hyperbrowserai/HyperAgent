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
  convertActionsToAnthropicTools,
  convertToAnthropicTool,
  createAnthropicToolChoice,
} from "../utils/schema-converter";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/index";
import { getDebugOptions } from "@/debug/options";
import { formatUnknownError } from "@/utils";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyRawPayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return formatUnknownError(value);
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

    const content = response.content.find((block) => block.type === "text");
    if (!content || typeof content.text !== "string") {
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
      ...request.options?.providerOptions,
    });

    const toolContent = response.content.find(
      (block: any) => block.type === "tool_use"
    ) as
      | { type: "tool_use"; name: string; input: Record<string, unknown> }
      | undefined;

    if (!toolContent) {
      return {
        rawText: stringifyRawPayload(response.content ?? []),
        parsed: null,
      };
    }

    const actionDefinition = request.actions.find(
      (action) => (action.toolName ?? action.type) === toolContent.name
    );
    if (!actionDefinition) {
      return {
        rawText: stringifyRawPayload(toolContent),
        parsed: null,
      };
    }

    const input = isRecord(toolContent.input) ? toolContent.input : {};
    const actionInput = isRecord(input.action) ? input.action : {};
    const params = actionInput.params ?? {};
    const thoughts = input.thoughts;
    const memory = input.memory;
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
        JSON.stringify(tool, null, 2)
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
      ...request.options?.providerOptions,
    });

    const content = response.content.find((block) => block.type === "tool_use");
    if (!content) {
      return {
        rawText: "",
        parsed: null,
      };
    }

    const input = content.input;
    if (!isRecord(input)) {
      return {
        rawText: stringifyRawPayload(input),
        parsed: null,
      };
    }

    try {
      const validated = request.schema.parse(input.result);
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
