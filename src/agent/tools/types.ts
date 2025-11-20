import { AgentActionDefinition } from "@/types/agent/actions/types";
import { MCPClient } from "../mcp/client";
import { HyperAgentLLM, HyperAgentMessage } from "@/llm/types";
import { HyperVariable } from "@/types/agent/types";
import { Page } from "playwright-core";
import { A11yDOMState } from "@/context-providers/a11y-dom/types";
import { OperationType, TokenUsage } from "@/types/metrics";

export interface LLMUsagePayload {
  usage?:
    | TokenUsage
    | {
        inputTokens?: number;
        outputTokens?: number;
        reasoningTokens?: number;
        promptTokens?: number;
        completionTokens?: number;
      };
  durationMs?: number;
  cacheHit?: boolean;
  prompt?: HyperAgentMessage[];
  response?: string;
  url?: string;
  instruction?: string;
  selector?: string;
  model?: string;
}

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
  initialDomState?: A11yDOMState;
  opType?: OperationType;
  selectorWarnings?: string[];
  recordLLMUsage?: (opType: OperationType, payload: LLMUsagePayload) => void;
}
