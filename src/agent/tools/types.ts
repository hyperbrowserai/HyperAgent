import { AgentActionDefinition } from "@/types/agent/actions/types";
import { MCPClient } from "../mcp/client";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HyperVariable } from "@/types/agent/types";

export type AgentCtx = {
  llm: BaseChatModel;
  actions: Array<AgentActionDefinition>;
  debug?: boolean;
  generateScript?: boolean;
  scriptFile?: string;
  debugDir?: string;
  tokenLimit: number;
  mcpClient?: MCPClient;
  variables: Record<string, HyperVariable>;
};
