import { AgentActionDefinition } from "@/types/agent/actions/types";
import { MCPClient } from "../mcp/client";
import { HyperAgentLLM } from "@/llm/types";
import { HyperVariable } from "@/types/agent/types";
import { ActionConfig } from "@/types/config";

export interface AgentCtx {
  mcpClient?: MCPClient;
  debugDir?: string;
  debug?: boolean;
  variables: Record<string, HyperVariable>;
  actions: Array<AgentActionDefinition>;
  tokenLimit: number;
  llm: HyperAgentLLM;
  actionConfig?: ActionConfig;
}
