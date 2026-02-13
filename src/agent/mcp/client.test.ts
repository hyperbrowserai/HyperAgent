import { MCPClient, normalizeMCPToolParams } from "@/agent/mcp/client";

describe("normalizeMCPToolParams", () => {
  it("returns object inputs unchanged", () => {
    const input = { query: "laptops", limit: 5 };
    expect(normalizeMCPToolParams(input)).toEqual(input);
  });

  it("parses valid JSON object strings", () => {
    const json = "{\"query\":\"weather\",\"units\":\"metric\"}";
    expect(normalizeMCPToolParams(json)).toEqual({
      query: "weather",
      units: "metric",
    });
  });

  it("throws for invalid JSON strings", () => {
    expect(() => normalizeMCPToolParams("{invalid")).toThrow(
      "Invalid MCP tool params JSON string"
    );
  });

  it("throws when parsed JSON is not an object", () => {
    expect(() => normalizeMCPToolParams("[1,2,3]")).toThrow(
      "must parse to a JSON object"
    );
  });
});

describe("MCPClient.executeTool server selection", () => {
  function setServers(
    client: MCPClient,
    servers: Map<
      string,
      {
        tools: Map<string, unknown>;
        client: { callTool: jest.Mock };
      }
    >
  ): void {
    (
      client as unknown as {
        servers: Map<
          string,
          {
            tools: Map<string, unknown>;
            client: { callTool: jest.Mock };
          }
        >;
      }
    ).servers = servers;
  }

  it("uses the only connected server when serverId is omitted", async () => {
    const mcpClient = new MCPClient(false);
    const callTool = jest.fn().mockResolvedValue({ content: [] });
    setServers(
      mcpClient,
      new Map([
        [
          "server-1",
          {
            tools: new Map([["search", {}]]),
            client: { callTool },
          },
        ],
      ])
    );

    await mcpClient.executeTool("search", { query: "weather" });

    expect(callTool).toHaveBeenCalledWith({
      name: "search",
      arguments: { query: "weather" },
    });
  });

  it("finds matching server by tool name when multiple are connected", async () => {
    const mcpClient = new MCPClient(false);
    const searchCallTool = jest.fn().mockResolvedValue({ content: [] });
    const notesCallTool = jest.fn().mockResolvedValue({ content: [] });
    setServers(
      mcpClient,
      new Map([
        [
          "server-a",
          {
            tools: new Map([["notes", {}]]),
            client: { callTool: notesCallTool },
          },
        ],
        [
          "server-b",
          {
            tools: new Map([["search", {}]]),
            client: { callTool: searchCallTool },
          },
        ],
      ])
    );

    await mcpClient.executeTool("search", { query: "coffee" });

    expect(searchCallTool).toHaveBeenCalledWith({
      name: "search",
      arguments: { query: "coffee" },
    });
    expect(notesCallTool).not.toHaveBeenCalled();
  });

  it("throws when provided serverId does not exist", async () => {
    const mcpClient = new MCPClient(false);
    setServers(
      mcpClient,
      new Map([
        [
          "server-a",
          {
            tools: new Map([["notes", {}]]),
            client: { callTool: jest.fn() },
          },
        ],
      ])
    );

    await expect(
      mcpClient.executeTool("search", { query: "missing" }, "unknown-server")
    ).rejects.toThrow("No valid server found for tool search");
  });
});
