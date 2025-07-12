import { AgentActionDefinition } from "@/types/agent/actions/types";
import { MCPClient } from "../mcp/client";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HyperVariable } from "@/types/agent/types";
import { HyperAgentConfig } from "@/types";

export type AgentCtx<T> = {
  llm: BaseChatModel;
  actions: Array<AgentActionDefinition>;
  debug?: boolean;
  generateScript?: boolean;
  scriptFile?: string;
  debugDir?: string;
  tokenLimit: number;
  mcpClient?: MCPClient;
  variables: Record<string, HyperVariable>;
  agentConfig?: HyperAgentConfig<T extends "Local" ? "Local" : "Hyperbrowser">;
};
