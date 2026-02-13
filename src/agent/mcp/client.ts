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
  if (typeof input === "string") {
    if (input.trim().length === 0) {
      throw new Error(
        "Invalid MCP tool params JSON string: input is empty"
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch (error) {
      const message = formatUnknownError(error);
      throw new Error(`Invalid MCP tool params JSON string: ${message}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        "MCP tool params must parse to a JSON object, not an array or primitive"
      );
    }
    return parsed as Record<string, unknown>;
  }

  return input;
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
