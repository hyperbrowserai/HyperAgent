import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AgentActionDefinition } from "./agent/actions/types";

import { z } from "zod";
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

export interface HyperAgentConfig {
  customActions?: Array<AgentActionDefinition>;

  debug?: boolean;
  llm?: BaseChatModel;
  outputSchema?: z.AnyZodObject;

  hyperbrowserConfig?: ConstructorParameters<typeof HyperbrowserProvider>[0];
  localOptions?: ConstructorParameters<typeof LocalBrowserProvider>[0];
}
