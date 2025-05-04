import { AgentActionDefinition } from "@/types/agent/actions/types";
import { MCPClient } from "../mcp/client";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HyperVariable } from "@/types/agent/types";

export interface AgentCtx {
  mcpClient?: MCPClient;
  debugDir?: string;
  debug?: boolean;
  variables: Record<string, HyperVariable>;
  actions: Array<AgentActionDefinition>;
  tokenLimit: number;
  llm: BaseChatModel;
}
