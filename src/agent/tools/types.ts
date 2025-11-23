import { AgentActionDefinition } from "@/types/agent/actions/types";
import { MCPClient } from "../mcp/client";
import { HyperAgentLLM } from "@/llm/types";
import { HyperVariable } from "@/types/agent/types";
import { Page } from "playwright-core";

export interface AgentCtx {
  mcpClient?: MCPClient;
  debugDir?: string;
  debug?: boolean;
  variables: Record<string, HyperVariable>;
  actions: Array<AgentActionDefinition>;
  tokenLimit: number;
  llm: HyperAgentLLM;
  cdpActions?: boolean;
  schemaErrors?: Array<{
    stepIndex: number;
    error: string;
    rawResponse: string;
  }>;
  activePage?: () => Promise<Page>;
}
