import { AgentActionDefinition } from "@/types/agent/actions/types";
import { z } from "zod";

export type HyperAgentRole = "system" | "user" | "assistant" | "tool";

export type HyperAgentTextPart = {
  type: "text";
  text: string;
};

export type HyperAgentImagePart = {
  type: "image";
  /** data URL or remote URL */
  url: string;
  /** optional mime type when using data URLs */
  mimeType?: string;
};

export type HyperAgentToolPart = {
  type: "tool_call";
  toolName: string;
  arguments: unknown;
};

export type HyperAgentContentPart =
  | HyperAgentTextPart
  | HyperAgentImagePart
  | HyperAgentToolPart;

export type HyperAgentMessage =
  | {
      role: Extract<HyperAgentRole, "system" | "user">;
      content: string | HyperAgentContentPart[];
    }
  | {
      role: Extract<HyperAgentRole, "assistant">;
      content: string | HyperAgentContentPart[];
      toolCalls?: Array<{ id?: string; name: string; arguments: unknown }>;
    }
  | {
      role: "tool";
      toolName: string;
      toolCallId?: string;
      content: string | HyperAgentContentPart[];
    };

export type HyperAgentCapabilities = {
  multimodal: boolean;
  toolCalling: boolean;
  jsonMode: boolean;
};

export type HyperAgentInvokeOptions = {
  temperature?: number;
  maxTokens?: number;
  /** provider specific; passed through unmodified */
  providerOptions?: Record<string, unknown>;
};

export type StructuredOutputRequest<TSchema extends z.ZodTypeAny> = {
  schema: TSchema;
  /** hints to providers */
  hints?: {
    forceJson?: boolean;
    toolName?: string;
  };
  options?: HyperAgentInvokeOptions;
  actions?: AgentActionDefinition[];
};

export type HyperAgentStructuredResult<TSchema extends z.ZodTypeAny> = {
  rawText: string;
  parsed: z.infer<TSchema> | null;
};

export interface HyperAgentLLM {
  invoke(
    messages: HyperAgentMessage[],
    options?: HyperAgentInvokeOptions
  ): Promise<{
    role: "assistant";
    content: string | HyperAgentContentPart[];
    toolCalls?: Array<{ id?: string; name: string; arguments: unknown }>;
    usage?: { inputTokens?: number; outputTokens?: number };
  }>;

  invokeStructured<TSchema extends z.ZodTypeAny>(
    request: StructuredOutputRequest<TSchema>,
    messages: HyperAgentMessage[]
  ): Promise<HyperAgentStructuredResult<TSchema>>;

  getProviderId(): string;
  getModelId(): string;
  getCapabilities(): HyperAgentCapabilities;
}
