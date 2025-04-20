import { AgentActionDefinition } from "@/types/agent/actions/types";
import { MCPClient } from "../mcp/client";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";

export interface AgentCtx {
  mcpClient?: MCPClient;
  debugDir?: string;
  debug?: boolean;
  actions: Array<AgentActionDefinition>;
  tokenLimit: number;
  llm: BaseChatModel;
}
