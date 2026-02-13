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
type MCPToolDiscoveryOptions = Pick<
  MCPServerConfig,
  "includeTools" | "excludeTools"
>;
type NormalizedDiscoveredMCPTool = {
  tool: Tool;
  normalizedName: string;
};
const MAX_MCP_PAYLOAD_CHARS = 4000;
const MAX_MCP_TOOL_PARAMS_JSON_CHARS = 100_000;
const MAX_MCP_PARAM_DEPTH = 25;
const MAX_MCP_PARAM_STRING_CHARS = 20_000;
const MAX_MCP_PARAM_KEY_CHARS = 256;
const MAX_MCP_PARAM_COLLECTION_SIZE = 500;
const MAX_MCP_IDENTIFIER_DIAGNOSTIC_CHARS = 128;
const MAX_MCP_TOOL_NAME_CHARS = 256;
const MAX_MCP_SERVER_ID_CHARS = 256;
const MAX_MCP_AMBIGUOUS_SERVER_IDS = 5;
const MAX_MCP_TOOL_DIAGNOSTIC_ITEMS = 10;
const MAX_MCP_CONFIG_SERVER_ID_CHARS = 128;
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

function hasAnyControlChars(value: string): boolean {
  return Array.from(value).some((char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code < 32) || code === 127;
  });
}

function validateParamStringValue(value: string): string {
  if (hasUnsupportedControlChars(value)) {
    throw new Error(
      "MCP tool params cannot include unsupported control characters in string values"
    );
  }
  if (value.length > MAX_MCP_PARAM_STRING_CHARS) {
    throw new Error(
      `MCP tool params cannot include string values longer than ${MAX_MCP_PARAM_STRING_CHARS} characters`
    );
  }
  return value;
}

function formatMCPIdentifier(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value : formatUnknownError(value);
  const normalized = raw
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (normalized.length === 0) {
    return fallback;
  }
  if (normalized.length <= MAX_MCP_IDENTIFIER_DIAGNOSTIC_CHARS) {
    return normalized;
  }
  return `${normalized.slice(
    0,
    MAX_MCP_IDENTIFIER_DIAGNOSTIC_CHARS
  )}... [truncated]`;
}

function normalizeMCPExecutionToolName(toolName: string): string {
  const normalized = toolName.trim();
  if (normalized.length === 0) {
    throw new Error("MCP tool name must be a non-empty string");
  }
  if (hasAnyControlChars(normalized)) {
    throw new Error("MCP tool name contains unsupported control characters");
  }
  if (normalized.length > MAX_MCP_TOOL_NAME_CHARS) {
    throw new Error(
      `MCP tool name exceeds ${MAX_MCP_TOOL_NAME_CHARS} characters`
    );
  }
  return normalized;
}

function normalizeMCPExecutionServerId(
  serverId?: string
): string | undefined {
  if (typeof serverId !== "string") {
    return undefined;
  }
  const normalized = serverId.trim();
  if (normalized.length === 0) {
    return undefined;
  }
  if (hasAnyControlChars(normalized)) {
    throw new Error("MCP serverId contains unsupported control characters");
  }
  if (normalized.length > MAX_MCP_SERVER_ID_CHARS) {
    throw new Error(
      `MCP serverId exceeds ${MAX_MCP_SERVER_ID_CHARS} characters`
    );
  }
  return normalized;
}

function normalizeMCPConnectionServerId(serverId?: string): string | undefined {
  if (typeof serverId === "undefined") {
    return undefined;
  }
  const normalized = serverId.trim();
  if (normalized.length === 0) {
    throw new Error("MCP server id must be a non-empty string when provided");
  }
  if (hasAnyControlChars(normalized)) {
    throw new Error("MCP server id contains unsupported control characters");
  }
  if (normalized.length > MAX_MCP_CONFIG_SERVER_ID_CHARS) {
    throw new Error(
      `MCP server id exceeds ${MAX_MCP_CONFIG_SERVER_ID_CHARS} characters`
    );
  }
  return normalized;
}

function normalizeMCPConnectionType(
  value?: MCPServerConfig["connectionType"]
): "stdio" | "sse" {
  if (typeof value === "undefined") {
    return "stdio";
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || hasAnyControlChars(normalized)) {
    throw new Error(
      'MCP connectionType must be either "stdio" or "sse" when provided'
    );
  }
  if (normalized === "stdio" || normalized === "sse") {
    return normalized;
  }
  throw new Error(
    'MCP connectionType must be either "stdio" or "sse" when provided'
  );
}

function summarizeMCPServerIds(serverIds: string[]): string {
  const preview = serverIds
    .slice(0, MAX_MCP_AMBIGUOUS_SERVER_IDS)
    .map((id) => formatMCPIdentifier(id, "unknown-server"));
  const omitted = serverIds.length - preview.length;
  if (omitted > 0) {
    return `${preview.join(", ")}, ... (+${omitted} more)`;
  }
  return preview.join(", ");
}

function summarizeMCPToolNames(toolNames: string[]): string {
  const preview = toolNames
    .slice(0, MAX_MCP_TOOL_DIAGNOSTIC_ITEMS)
    .map((name) => formatMCPIdentifier(name, "unknown-tool"));
  const omitted = toolNames.length - preview.length;
  if (omitted > 0) {
    return `${preview.join(", ")}, ... (+${omitted} more)`;
  }
  return preview.join(", ");
}

function normalizeMCPToolFilterList(
  value: string[] | undefined,
  fieldName: "includeTools" | "excludeTools"
): Set<string> | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`MCP ${fieldName} must be an array of tool names`);
  }
  const normalizedValues = value.map((name) =>
    normalizeMCPExecutionToolName(name)
  );
  const seenNames = new Set<string>();
  const seenNamesLower = new Set<string>();
  for (const normalizedName of normalizedValues) {
    const lower = normalizedName.toLowerCase();
    if (seenNamesLower.has(lower)) {
      throw new Error(
        `MCP ${fieldName} contains duplicate tool name "${formatMCPIdentifier(
          normalizedName,
          "unknown-tool"
        )}" after normalization`
      );
    }
    seenNamesLower.add(lower);
    seenNames.add(normalizedName);
  }
  return seenNames;
}

export function normalizeDiscoveredMCPTools(
  tools: Tool[],
  options: MCPToolDiscoveryOptions
): NormalizedDiscoveredMCPTool[] {
  const includeSet = normalizeMCPToolFilterList(
    options.includeTools,
    "includeTools"
  );
  const excludeSet = normalizeMCPToolFilterList(
    options.excludeTools,
    "excludeTools"
  );
  if (includeSet && excludeSet) {
    const includeLookup = new Set(
      Array.from(includeSet).map((name) => name.toLowerCase())
    );
    const overlap = Array.from(excludeSet).filter((name) =>
      includeLookup.has(name.toLowerCase())
    );
    if (overlap.length > 0) {
      throw new Error(
        `MCP includeTools and excludeTools overlap on: ${summarizeMCPToolNames(
          overlap
        )}`
      );
    }
  }
  const seenToolNames = new Set<string>();
  const normalizedTools: NormalizedDiscoveredMCPTool[] = [];

  for (const tool of tools) {
    const normalizedName = normalizeMCPExecutionToolName(tool.name);
    if (seenToolNames.has(normalizedName)) {
      throw new Error(
        `MCP server returned duplicate tool name "${formatMCPIdentifier(
          normalizedName,
          "unknown-tool"
        )}"`
      );
    }
    seenToolNames.add(normalizedName);

    if (includeSet && !includeSet.has(normalizedName)) {
      continue;
    }
    if (excludeSet && excludeSet.has(normalizedName)) {
      continue;
    }

    normalizedTools.push({
      tool,
      normalizedName,
    });
  }

  if (includeSet && normalizedTools.length === 0) {
    const includeNames = summarizeMCPToolNames(Array.from(includeSet));
    const availableNames =
      seenToolNames.size === 0
        ? "none"
        : summarizeMCPToolNames(Array.from(seenToolNames));
    throw new Error(
      `No MCP tools matched includeTools filter (${includeNames}). Available tools: ${availableNames}.`
    );
  }

  return normalizedTools;
}

function findConnectedServerId(
  servers: Map<string, ServerConnection>,
  requestedId: string
): string | undefined {
  if (servers.has(requestedId)) {
    return requestedId;
  }
  const requestedLookup = requestedId.toLowerCase();
  for (const existingId of servers.keys()) {
    if (existingId.toLowerCase() === requestedLookup) {
      return existingId;
    }
  }
  return undefined;
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
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("MCP tool params cannot include non-finite number values");
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
    if (typeof value === "string") {
      return validateParamStringValue(value);
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
          const trimmedMapKey = normalizedRawKey.trim();
          if (trimmedMapKey.length === 0) {
            throw new Error("MCP tool params cannot include empty keys");
          }
          if (trimmedMapKey.length > MAX_MCP_PARAM_KEY_CHARS) {
            throw new Error(
              `MCP tool params cannot include keys longer than ${MAX_MCP_PARAM_KEY_CHARS} characters`
            );
          }
          if (hasAnyControlChars(trimmedMapKey)) {
            throw new Error(
              "MCP tool params cannot include keys with control characters"
            );
          }
          const normalizedMapKey = trimmedMapKey.replace(/\s+/g, " ");
          if (seenMapKeys.has(normalizedMapKey)) {
            throw new Error(
              `MCP tool params cannot include duplicate key after trimming: "${normalizedMapKey}"`
            );
          }
          seenMapKeys.add(normalizedMapKey);
          sanitizedMap[normalizedMapKey] = sanitizeParamValue(
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
        return validateParamStringValue(formatUnknownError(value));
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
          const trimmedObjectKey = key.trim();
          if (trimmedObjectKey.length === 0) {
            throw new Error("MCP tool params cannot include empty keys");
          }
          if (trimmedObjectKey.length > MAX_MCP_PARAM_KEY_CHARS) {
            throw new Error(
              `MCP tool params cannot include keys longer than ${MAX_MCP_PARAM_KEY_CHARS} characters`
            );
          }
          if (hasAnyControlChars(trimmedObjectKey)) {
            throw new Error(
              "MCP tool params cannot include keys with control characters"
            );
          }
          const normalizedObjectKey = trimmedObjectKey.replace(/\s+/g, " ");
          const normalizedKey = normalizeParamKey(key);
          if (UNSAFE_OBJECT_KEYS.has(normalizedKey)) {
            throw new Error(`MCP tool params cannot include reserved key "${key}"`);
          }
          if (seenKeys.has(normalizedObjectKey)) {
            throw new Error(
              `MCP tool params cannot include duplicate key after trimming: "${normalizedObjectKey}"`
            );
          }
          seenKeys.add(normalizedObjectKey);
          sanitized[normalizedObjectKey] = sanitizeParamValue(
            paramValue,
            seen,
            depth + 1
          );
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
      const normalizedConfigServerId = normalizeMCPConnectionServerId(
        serverConfig.id
      );
      const serverId = normalizedConfigServerId || uuidv4();
      const existingServerId = findConnectedServerId(this.servers, serverId);
      if (existingServerId) {
        throw new Error(
          `MCP server with ID "${formatMCPIdentifier(
            serverId,
            "unknown-server"
          )}" is already connected`
        );
      }

      // Create transport for this server
      let transport;
      const connectionType = normalizeMCPConnectionType(
        serverConfig?.connectionType
      );

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

      const discoveredTools = normalizeDiscoveredMCPTools(
        toolsResult.tools,
        serverConfig
      );

      // Create actions for each tool
      const actions = discoveredTools.map(({ tool, normalizedName }) => {
          // Store tool reference for later use
          toolsMap.set(normalizedName, tool);

          // Create action definition
          return {
            type: normalizedName,
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
                normalizedName,
                params,
                targetServerId
              );

              return {
                success: true,
                message: `MCP tool ${normalizedName} execution successful: ${stringifyMCPPayload(result)}`,
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
    parameters: Record<string, unknown> | string,
    serverId?: string
  ): Promise<MCPToolResult> {
    const normalizedParameters = normalizeMCPToolParams(parameters);
    const normalizedToolName = normalizeMCPExecutionToolName(toolName);
    const normalizedServerId = normalizeMCPExecutionServerId(serverId);
    const safeToolName = formatMCPIdentifier(normalizedToolName, "unknown-tool");
    const safeServerId = (): string =>
      formatMCPIdentifier(serverId, "unknown-server");

    // If no server ID provided and only one server exists, use that one
    if (!normalizedServerId && this.servers.size === 1) {
      serverId = [...this.servers.keys()][0];
    }

    // If no server ID provided and multiple servers exist, try to find one with the tool
    if (!normalizedServerId && this.servers.size > 1) {
      const matchingServerIds: string[] = [];
      for (const [id, server] of this.servers.entries()) {
        if (server.tools.has(normalizedToolName)) {
          matchingServerIds.push(id);
        }
      }
      if (matchingServerIds.length === 1) {
        serverId = matchingServerIds[0];
      }
      if (matchingServerIds.length > 1) {
        throw new Error(
          `Tool "${safeToolName}" is registered on multiple servers (${summarizeMCPServerIds(
            matchingServerIds
          )}). Provide serverId explicitly.`
        );
      }
    } else if (normalizedServerId) {
      serverId = findConnectedServerId(this.servers, normalizedServerId);
    }

    if (!serverId || !this.servers.has(serverId)) {
      throw new Error(`No valid server found for tool ${safeToolName}`);
    }

    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Server with ID ${safeServerId()} not found`);
    }
    const registeredTool = server.tools.get(normalizedToolName);
    if (!registeredTool) {
      throw new Error(
        `Tool "${safeToolName}" is not registered on server "${safeServerId()}"`
      );
    }

    try {
      const remoteToolName =
        typeof registeredTool.name === "string" &&
        registeredTool.name.length > 0
          ? registeredTool.name
          : normalizedToolName;
      const result = await server.client.callTool({
        name: remoteToolName,
        arguments: normalizedParameters,
      });

      return result;
    } catch (error) {
      const message = formatUnknownError(error);
      console.error(
        `Error executing tool ${safeToolName} on server ${safeServerId()}: ${message}`
      );
      throw new Error(
        `Error executing tool ${safeToolName} on server ${safeServerId()}: ${message}`
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
  hasTool(toolName: string): {
    exists: boolean;
    serverId?: string;
    serverIds?: string[];
    isAmbiguous?: boolean;
  } {
    let normalizedToolName: string;
    try {
      normalizedToolName = normalizeMCPExecutionToolName(toolName);
    } catch {
      return { exists: false };
    }
    const matchingServerIds: string[] = [];
    for (const [serverId, server] of this.servers.entries()) {
      if (server.tools.has(normalizedToolName)) {
        matchingServerIds.push(serverId);
      }
    }
    if (matchingServerIds.length === 0) {
      return { exists: false };
    }
    if (matchingServerIds.length === 1) {
      return { exists: true, serverId: matchingServerIds[0] };
    }
    return {
      exists: true,
      serverId: matchingServerIds[0],
      serverIds: matchingServerIds,
      isAmbiguous: true,
    };
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
