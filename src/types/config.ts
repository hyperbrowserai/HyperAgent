import { AgentActionDefinition } from "./agent/actions/types";
import { HyperAgentLLM, LLMConfig } from "@/llm/providers";

import {
  HyperbrowserProvider,
  LocalBrowserProvider,
} from "@/browser-providers";
import type { Page as PlaywrightPage, BrowserContext } from "playwright-core";

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

/**
 * Placeholder connector configuration for the Phase 4 connector-only flow.
 * Currently unused but defined so implementers can start wiring connectors
 * without touching the legacy provider surface.
 */
export interface PlaywrightConnectorOptions {
  page: PlaywrightPage;
  context?: BrowserContext;
}

export interface HyperAgentConnectorConfig {
  driver: "playwright"; // Future drivers (puppeteer, raw CDP) will extend this union.
  options: PlaywrightConnectorOptions;
}

export interface HyperAgentOptions<T extends BrowserProviders = "Local"> {
  customActions?: Array<AgentActionDefinition>;

  browserProvider?: T;
  /**
   * Connector configuration (future Phase 4). Mutually exclusive with browserProvider.
   */
  connectorConfig?: HyperAgentConnectorConfig;

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
  cdpActions?: boolean;
  debugOptions?: {
    cdpSessions?: boolean;
    traceWait?: boolean;
    profileDomCapture?: boolean;
    structuredSchema?: boolean;
  };

  /**
   * Directory to persist deterministic cache entries. Relative paths are resolved from CWD.
   * Caching is disabled when omitted.
   */
  cacheDir?: string;

  /**
   * Maximum history entries to keep in-memory. Defaults to 200.
   */
  historyLimit?: number;

  /**
   * Write inference traces to the provided path. When true, defaults to debug/llm.log.
   */
  logInferenceToFile?: string | true;

  /**
   * Opt-in per-run metrics logging.
   */
  logMetrics?: boolean;
}

/**
 * Backwards compatible alias for consumers still importing HyperAgentConfig.
 */
export type HyperAgentConfig<T extends BrowserProviders = "Local"> =
  HyperAgentOptions<T>;
