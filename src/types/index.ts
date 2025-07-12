// Agent Action Types
import {
  ActionType,
  ActionSchemaType,
  AgentActionDefinition,
  ActionContext,
  ActionOutput,
} from "./agent/actions/types";

// Agent Types
import {
  AgentOutputFn,
  AgentOutput,
  AgentStep,
  VariableExtractionOutput,
  TaskParams,
  TaskOutput,
  Task,
  TaskStatus,
  TaskState,
  endTaskStatuses,
  HyperVariable,
} from "./agent/types";

// Config Types
import { MCPServerConfig, MCPConfig, HyperAgentConfig } from "./config";

// Browser Provider Types
import BrowserProvider from "./browser-providers/types";

// Export all types
export {
  // Agent Action Types
  ActionType,
  ActionSchemaType,
  AgentActionDefinition,
  ActionContext,
  ActionOutput,

  // Agent Types
  AgentOutputFn,
  AgentOutput,
  AgentStep,
  TaskParams,
  TaskOutput,
  Task,
  TaskStatus,
  TaskState,

  // Config Types
  MCPServerConfig,
  MCPConfig,
  HyperAgentConfig,

  // Browser Provider Types
  BrowserProvider,
  endTaskStatuses,

  // Helper Types
  VariableExtractionOutput,
  HyperVariable,
};

// Extend NodeJS.ProcessEnv to include our environment variables
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface ProcessEnv {
      OPENAI_API_KEY?: string;
      GEMINI_API_KEY?: string;
    }
  }
}
