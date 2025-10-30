import { AgentActionDefinition } from "./agent/actions/types";
import { HyperAgentLLM, LLMConfig } from "@/llm/providers";

import {
  HyperbrowserProvider,
  LocalBrowserProvider,
} from "@/browser-providers";

export interface MCPServerConfig {
  id?: string;

  /**
   * The type of MCP server to use
   */
  connectionType?: "stdio" | "sse";

  /**
   * The executable to run to start the server.
   */
  command?: string;
  /**
   * Command line arguments to pass to the executable.
   */
  args?: string[];
  /**
   * The environment to use when spawning the process.
   *
   */
  env?: Record<string, string>;

  /**
   * URL for SSE connection (required when connectionType is "sse")
   */
  sseUrl?: string;
  /**
   * Headers for SSE connection
   */
  sseHeaders?: Record<string, string>;

  /**
   * List of tools to exclude from the MCP config
   */
  excludeTools?: string[];
  /**
   * List of tools to include from the MCP config
   */
  includeTools?: string[];
}

export interface MCPConfig {
  /**
   * List of servers to connect to
   */
  servers: MCPServerConfig[];
}

export type BrowserProviders = "Local" | "Hyperbrowser";

export interface ActionConfig {
  /**
   * Configuration for the clickElement action
   */
  clickElement?: {
    /**
     * Timeout in milliseconds for click operations
     * This controls how long to wait for elements to be visible, enabled, and stable before clicking
     * @default 2500
     */
    timeout?: number;
  };
}

export interface HyperAgentConfig<T extends BrowserProviders = "Local"> {
  customActions?: Array<AgentActionDefinition>;

  browserProvider?: T;

  debug?: boolean;
  llm?: HyperAgentLLM | LLMConfig;

  hyperbrowserConfig?: Omit<
    NonNullable<ConstructorParameters<typeof HyperbrowserProvider>[0]>,
    "debug"
  >;
  localConfig?: ConstructorParameters<typeof LocalBrowserProvider>[0];

  /**
   * Configuration for agent actions
   */
  actionConfig?: ActionConfig;
}
