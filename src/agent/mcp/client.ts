import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Tool } from "@modelcontextprotocol/sdk/types";
import { MCPServerConfig } from "@/types/config";
import { ActionContext, ActionOutput, AgentActionDefinition } from "@/types";
import { formatUnknownError } from "@/utils";
import { v4 as uuidv4 } from "uuid";

interface ServerConnection {
  id: string;
  config: MCPServerConfig;
  client: Client;
  transport: StdioClientTransport | SSEClientTransport;
  tools: Map<string, Tool>;
  actions: AgentActionDefinition[];
}

type MCPToolResult = Awaited<ReturnType<Client["callTool"]>>;
const MAX_MCP_PAYLOAD_CHARS = 4000;
const MAX_MCP_TOOL_PARAMS_JSON_CHARS = 100_000;
const MAX_MCP_PARAM_DEPTH = 25;
const MAX_MCP_PARAM_STRING_CHARS = 20_000;
const MAX_MCP_PARAM_KEY_CHARS = 256;
const MAX_MCP_PARAM_COLLECTION_SIZE = 500;
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function hasUnsupportedControlChars(value: string): boolean {
  return Array.from(value).some((char) => {
    const code = char.charCodeAt(0);
    return (
      (code >= 0 && code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      code === 127
    );
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const MCPToolActionParams = z.object({
  params: z
    .union([z.string(), z.record(z.string(), z.unknown())])
    .describe(
      "Parameters for the MCP tool. Provide either a JSON object directly or a JSON string."
    ),
});

type MCPToolActionInput = z.infer<typeof MCPToolActionParams>;

export function stringifyMCPPayload(value: unknown): string {
  const truncate = (content: string): string =>
    content.length <= MAX_MCP_PAYLOAD_CHARS
      ? content
      : `${content.slice(0, MAX_MCP_PAYLOAD_CHARS)}... [truncated]`;

  try {
    const serialized = JSON.stringify(value);
    return truncate(
      typeof serialized === "string"
        ? serialized
        : formatUnknownError(value)
    );
  } catch {
    return truncate(formatUnknownError(value));
  }
}

export function normalizeMCPToolParams(
  input: MCPToolActionInput["params"]
): Record<string, unknown> {
  const normalizeParamKey = (value: string): string => value.trim().toLowerCase();

  const sanitizeParamValue = (
    value: unknown,
    seen: WeakSet<object>,
    depth: number
  ): unknown => {
    if (depth > MAX_MCP_PARAM_DEPTH) {
      throw new Error(
        `MCP tool params exceed maximum nesting depth of ${MAX_MCP_PARAM_DEPTH}`
      );
    }

    if (Array.isArray(value)) {
      if (seen.has(value)) {
        throw new Error("MCP tool params cannot include circular references");
      }
      if (value.length > MAX_MCP_PARAM_COLLECTION_SIZE) {
        throw new Error(
          `MCP tool params cannot include collections with more than ${MAX_MCP_PARAM_COLLECTION_SIZE} entries`
        );
      }
      seen.add(value);
      try {
        return value.map((entry) => sanitizeParamValue(entry, seen, depth + 1));
      } finally {
        seen.delete(value);
      }
    }
    if (typeof value === "bigint") {
      return `${value.toString()}n`;
    }
    if (typeof value === "symbol") {
      return value.toString();
    }
    if (typeof value === "function") {
      return `[Function ${value.name || "anonymous"}]`;
    }
    if (typeof value === "string" && hasUnsupportedControlChars(value)) {
      throw new Error(
        "MCP tool params cannot include unsupported control characters in string values"
      );
    }
    if (
      typeof value === "string" &&
      value.length > MAX_MCP_PARAM_STRING_CHARS
    ) {
      throw new Error(
        `MCP tool params cannot include string values longer than ${MAX_MCP_PARAM_STRING_CHARS} characters`
      );
    }
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? value.toString() : value.toISOString();
    }
    if (value instanceof Set) {
      if (seen.has(value)) {
        throw new Error("MCP tool params cannot include circular references");
      }
      if (value.size > MAX_MCP_PARAM_COLLECTION_SIZE) {
        throw new Error(
          `MCP tool params cannot include collections with more than ${MAX_MCP_PARAM_COLLECTION_SIZE} entries`
        );
      }
      seen.add(value);
      try {
        return Array.from(value).map((entry) =>
          sanitizeParamValue(entry, seen, depth + 1)
        );
      } finally {
        seen.delete(value);
      }
    }
    if (value instanceof Map) {
      if (seen.has(value)) {
        throw new Error("MCP tool params cannot include circular references");
      }
      if (value.size > MAX_MCP_PARAM_COLLECTION_SIZE) {
        throw new Error(
          `MCP tool params cannot include collections with more than ${MAX_MCP_PARAM_COLLECTION_SIZE} entries`
        );
      }
      seen.add(value);
      try {
        const sanitizedMap: Record<string, unknown> = Object.create(null);
        const seenMapKeys = new Set<string>();
        for (const [rawKey, mapValue] of value.entries()) {
          const normalizedRawKey =
            typeof rawKey === "string" ? rawKey : formatUnknownError(rawKey);
          const trimmedKey = normalizedRawKey.trim();
          if (trimmedKey.length === 0) {
            throw new Error("MCP tool params cannot include empty keys");
          }
          if (trimmedKey.length > MAX_MCP_PARAM_KEY_CHARS) {
            throw new Error(
              `MCP tool params cannot include keys longer than ${MAX_MCP_PARAM_KEY_CHARS} characters`
            );
          }
          if (hasUnsupportedControlChars(trimmedKey)) {
            throw new Error(
              "MCP tool params cannot include keys with control characters"
            );
          }
          if (seenMapKeys.has(trimmedKey)) {
            throw new Error(
              `MCP tool params cannot include duplicate key after trimming: "${trimmedKey}"`
            );
          }
          seenMapKeys.add(trimmedKey);
          sanitizedMap[trimmedKey] = sanitizeParamValue(
            mapValue,
            seen,
            depth + 1
          );
        }
        return sanitizedMap;
      } finally {
        seen.delete(value);
      }
    }
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        throw new Error("MCP tool params cannot include circular references");
      }
      if (!isPlainRecord(value)) {
        return formatUnknownError(value);
      }
      seen.add(value);
      try {
        const sanitized: Record<string, unknown> = Object.create(null);
        const entries = Object.entries(value);
        if (entries.length > MAX_MCP_PARAM_COLLECTION_SIZE) {
          throw new Error(
            `MCP tool params cannot include collections with more than ${MAX_MCP_PARAM_COLLECTION_SIZE} entries`
          );
        }
        const seenKeys = new Set<string>();
        for (const [key, paramValue] of entries) {
          const trimmedKey = key.trim();
          if (trimmedKey.length === 0) {
            throw new Error("MCP tool params cannot include empty keys");
          }
          if (trimmedKey.length > MAX_MCP_PARAM_KEY_CHARS) {
            throw new Error(
              `MCP tool params cannot include keys longer than ${MAX_MCP_PARAM_KEY_CHARS} characters`
            );
          }
          if (hasUnsupportedControlChars(trimmedKey)) {
            throw new Error(
              "MCP tool params cannot include keys with control characters"
            );
          }
          const normalizedKey = normalizeParamKey(key);
          if (UNSAFE_OBJECT_KEYS.has(normalizedKey)) {
            throw new Error(`MCP tool params cannot include reserved key "${key}"`);
          }
          if (seenKeys.has(trimmedKey)) {
            throw new Error(
              `MCP tool params cannot include duplicate key after trimming: "${trimmedKey}"`
            );
          }
          seenKeys.add(trimmedKey);
          sanitized[trimmedKey] = sanitizeParamValue(paramValue, seen, depth + 1);
        }
        return sanitized;
      } finally {
        seen.delete(value);
      }
    }
    return value;
  };

  const sanitizeParamObject = (
    value: Record<string, unknown>
  ): Record<string, unknown> =>
    sanitizeParamValue(value, new WeakSet<object>(), 0) as Record<string, unknown>;

  if (typeof input === "string") {
    const trimmedInput = input.trim();
    if (trimmedInput.length === 0) {
      throw new Error(
        "Invalid MCP tool params JSON string: input is empty"
      );
    }
    if (hasUnsupportedControlChars(trimmedInput)) {
      throw new Error(
        "Invalid MCP tool params JSON string: contains unsupported control characters"
      );
    }
    if (trimmedInput.length > MAX_MCP_TOOL_PARAMS_JSON_CHARS) {
      throw new Error(
        `Invalid MCP tool params JSON string: exceeds ${MAX_MCP_TOOL_PARAMS_JSON_CHARS} characters`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmedInput);
    } catch (error) {
      const message = formatUnknownError(error);
      throw new Error(`Invalid MCP tool params JSON string: ${message}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        "MCP tool params must parse to a JSON object, not an array or primitive"
      );
    }
    return sanitizeParamObject(parsed as Record<string, unknown>);
  }

  return sanitizeParamObject(input);
}

class MCPClient {
  private servers: Map<string, ServerConnection> = new Map();
  private debug: boolean;
  constructor(debug: boolean = false) {
    this.debug = debug;
  }

  /**
   * Connect to an MCP server and register its tools
   * @param serverConfig The server configuration
   * @returns List of action definitions provided by the server
   */
  async connectToServer(
    serverConfig: MCPServerConfig
  ): Promise<{ serverId: string; actions: AgentActionDefinition[] }> {
    try {
      // Generate or use provided server ID
      const serverId = serverConfig.id || uuidv4();
      if (this.servers.has(serverId)) {
        throw new Error(`MCP server with ID "${serverId}" is already connected`);
      }

      // Create transport for this server
      let transport;
      const connectionType = serverConfig?.connectionType || "stdio";

      if (connectionType === "sse") {
        if (!serverConfig.sseUrl) {
          throw new Error("SSE URL is required for SSE connection type");
        }

        if (this.debug) {
          console.log(
            `Establishing SSE connection to ${serverConfig.sseUrl}...`
          );
        }

        transport = new SSEClientTransport(
          new URL(serverConfig.sseUrl),
          serverConfig.sseHeaders
            ? {
                requestInit: {
                  headers: serverConfig.sseHeaders,
                },
              }
            : undefined
        );

        transport.onerror = (error: unknown) => {
          const message = formatUnknownError(error);
          console.error(`SSE error: ${message}`);
        };
      } else {
        if (!serverConfig.command) {
          throw new Error("Command is required for stdio connection type");
        }

        transport = new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args,
          env: {
            ...((process.env ?? {}) as Record<string, string>),
            ...(serverConfig.env ?? {}),
          },
          // Pipe stdin/stdout, ignore stderr
          stderr: this.debug ? "inherit" : "ignore",
        });
      }

      const client = new Client({
        name: `hyperagent-mcp-client-${serverId}`,
        version: "1.0.0",
      });

      await client.connect(transport);

      const toolsResult = await client.listTools();
      const toolsMap = new Map<string, Tool>();

      // Create actions for each tool
      const actions = toolsResult.tools
        .filter((tool) => {
          if (
            serverConfig.includeTools &&
            !serverConfig.includeTools.includes(tool.name)
          ) {
            return false;
          }
          if (
            serverConfig.excludeTools &&
            serverConfig.excludeTools.includes(tool.name)
          ) {
            return false;
          }
          return true;
        })
        .map((tool) => {
          // Store tool reference for later use
          toolsMap.set(tool.name, tool);

          // Create action definition
          return {
            type: tool.name,
            actionParams: MCPToolActionParams.describe(
              `${tool.description ?? ""} Tool input schema: ${stringifyMCPPayload(tool.inputSchema)}`
            ),
            run: async (
              ctx: ActionContext,
              action: MCPToolActionInput
            ): Promise<ActionOutput> => {
              if (!ctx.mcpClient) {
                throw new Error(
                  "MCP client not available. Please ensure an MCP server is connected."
                );
              }

              const params = normalizeMCPToolParams(action.params);
              const targetServerId = serverId;

              const result = await ctx.mcpClient.executeTool(
                tool.name,
                params,
                targetServerId
              );

              return {
                success: true,
                message: `MCP tool ${tool.name} execution successful: ${stringifyMCPPayload(result)}`,
              };
            },
          };
        });

      // Store server connection
      this.servers.set(serverId, {
        id: serverId,
        config: serverConfig,
        client,
        transport,
        tools: toolsMap,
        actions,
      });
      if (this.debug) {
        console.log(`Connected to MCP server with ID: ${serverId}`);
        console.log("Added tools:", Array.from(toolsMap.keys()));
      }
      return { serverId, actions };
    } catch (error) {
      console.error(
        `Failed to connect to MCP server: ${formatUnknownError(error)}`
      );
      throw error;
    }
  }

  /**
   * Execute a tool on a specific server
   * @param toolName The name of the tool to execute
   * @param parameters The parameters to pass to the tool
   * @param serverId The ID of the server to use (optional)
   * @returns The result of the tool execution
   */
  async executeTool(
    toolName: string,
    parameters: Record<string, unknown>,
    serverId?: string
  ): Promise<MCPToolResult> {
    // If no server ID provided and only one server exists, use that one
    if (!serverId && this.servers.size === 1) {
      serverId = [...this.servers.keys()][0];
    }

    // If no server ID provided and multiple servers exist, try to find one with the tool
    if (!serverId && this.servers.size > 1) {
      for (const [id, server] of this.servers.entries()) {
        if (server.tools.has(toolName)) {
          serverId = id;
          break;
        }
      }
    }

    if (!serverId || !this.servers.has(serverId)) {
      throw new Error(`No valid server found for tool ${toolName}`);
    }

    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Server with ID ${serverId} not found`);
    }
    if (!server.tools.has(toolName)) {
      throw new Error(
        `Tool "${toolName}" is not registered on server "${serverId}"`
      );
    }

    try {
      const result = await server.client.callTool({
        name: toolName,
        arguments: parameters,
      });

      return result;
    } catch (error) {
      const message = formatUnknownError(error);
      console.error(
        `Error executing tool ${toolName} on server ${serverId}: ${message}`
      );
      throw new Error(
        `Error executing tool ${toolName} on server ${serverId}: ${message}`
      );
    }
  }

  /**
   * Get all registered action definitions from all connected servers
   * @returns Array of action definitions
   */
  getAllActions(): AgentActionDefinition[] {
    const allActions: AgentActionDefinition[] = [];
    for (const server of this.servers.values()) {
      allActions.push(...server.actions);
    }
    return allActions;
  }

  /**
   * Get the IDs of all connected servers
   * @returns Array of server IDs
   */
  getServerIds(): string[] {
    return [...this.servers.keys()];
  }

  /**
   * Disconnect from a specific server
   * @param serverId The ID of the server to disconnect from
   */
  async disconnectServer(serverId: string): Promise<void> {
    const server = this.servers.get(serverId);
    if (server) {
      let closeError: unknown;
      try {
        await server.transport.close();
      } catch (error) {
        closeError = error;
      } finally {
        this.servers.delete(serverId);
      }
      if (closeError) {
        throw closeError;
      }
      if (this.debug) {
        console.log(`Disconnected from MCP server with ID: ${serverId}`);
      }
    }
  }

  /**
   * Disconnect from all servers
   */
  async disconnect(): Promise<void> {
    for (const serverId of Array.from(this.servers.keys())) {
      try {
        await this.disconnectServer(serverId);
      } catch (error) {
        console.error(
          `Failed to disconnect MCP server ${serverId}: ${formatUnknownError(error)}`
        );
      }
    }
  }

  /**
   * Check if a tool exists on any connected server
   * @param toolName The name of the tool to check
   * @returns Boolean indicating if the tool exists and the server ID it exists on
   */
  hasTool(toolName: string): { exists: boolean; serverId?: string } {
    for (const [serverId, server] of this.servers.entries()) {
      if (server.tools.has(toolName)) {
        return { exists: true, serverId };
      }
    }
    return { exists: false };
  }

  /**
   * Get information about all connected servers
   * @returns Array of server information objects
   */
  getServerInfo(): Array<{
    id: string;
    toolCount: number;
    toolNames: string[];
  }> {
    return Array.from(this.servers.entries()).map(([id, server]) => ({
      id,
      toolCount: server.tools.size,
      toolNames: Array.from(server.tools.keys()),
    }));
  }

  /**
   * Check if any servers are connected
   * @returns Boolean indicating if any servers are connected
   */
  hasConnections(): boolean {
    return this.servers.size > 0;
  }
}

export { MCPClient };
