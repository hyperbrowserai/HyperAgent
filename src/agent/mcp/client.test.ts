import { MCPClient, normalizeMCPToolParams } from "@/agent/mcp/client";

function setServersForClient(client: MCPClient, servers: Map<string, unknown>): void {
  (client as unknown as { servers: Map<string, unknown> }).servers = servers;
}

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

describe("MCPClient.connectToServer validation", () => {
  it("throws when connecting with duplicate server id", async () => {
    const mcpClient = new MCPClient(false);
    setServersForClient(
      mcpClient,
      new Map([
        [
          "server-1",
          {
            tools: new Map(),
          },
        ],
      ])
    );
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        mcpClient.connectToServer({
          id: "server-1",
          command: "echo",
        })
      ).rejects.toThrow('MCP server with ID "server-1" is already connected');
    } finally {
      errorSpy.mockRestore();
    }
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
    setServersForClient(
      client,
      servers as unknown as Map<string, unknown>
    );
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

  it("throws when only connected server lacks requested tool", async () => {
    const mcpClient = new MCPClient(false);
    const callTool = jest.fn();
    setServers(
      mcpClient,
      new Map([
        [
          "server-1",
          {
            tools: new Map([["notes", {}]]),
            client: { callTool },
          },
        ],
      ])
    );

    await expect(
      mcpClient.executeTool("search", { query: "weather" })
    ).rejects.toThrow('Tool "search" is not registered on server "server-1"');
    expect(callTool).not.toHaveBeenCalled();
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

  it("throws when target server is connected but missing the tool", async () => {
    const mcpClient = new MCPClient(false);
    const callTool = jest.fn();
    setServers(
      mcpClient,
      new Map([
        [
          "server-a",
          {
            tools: new Map([["notes", {}]]),
            client: { callTool },
          },
        ],
      ])
    );

    await expect(
      mcpClient.executeTool("search", { query: "missing" }, "server-a")
    ).rejects.toThrow('Tool "search" is not registered on server "server-a"');
    expect(callTool).not.toHaveBeenCalled();
  });

  it("wraps non-Error callTool failures with readable messages", async () => {
    const mcpClient = new MCPClient(false);
    const callTool = jest.fn().mockRejectedValue({ reason: "tool exploded" });
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
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

    try {
      await expect(
        mcpClient.executeTool("search", { query: "weather" })
      ).rejects.toThrow(
        'Error executing tool search on server server-1: {"reason":"tool exploded"}'
      );
      expect(errorSpy).toHaveBeenCalledWith(
        'Error executing tool search on server server-1: {"reason":"tool exploded"}'
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("MCPClient disconnect lifecycle", () => {
  function setServers(client: MCPClient, servers: Map<string, unknown>): void {
    setServersForClient(client, servers);
  }

  it("disconnectServer closes transport and removes server", async () => {
    const mcpClient = new MCPClient(false);
    const close = jest.fn().mockResolvedValue(undefined);
    setServers(
      mcpClient,
      new Map([
        [
          "server-1",
          {
            transport: { close },
          },
        ],
      ])
    );

    await mcpClient.disconnectServer("server-1");

    expect(close).toHaveBeenCalledTimes(1);
    expect(mcpClient.getServerIds()).toEqual([]);
    expect(mcpClient.hasConnections()).toBe(false);
  });

  it("disconnect closes every connected server transport", async () => {
    const mcpClient = new MCPClient(false);
    const closeA = jest.fn().mockResolvedValue(undefined);
    const closeB = jest.fn().mockResolvedValue(undefined);
    setServers(
      mcpClient,
      new Map([
        [
          "server-a",
          {
            transport: { close: closeA },
          },
        ],
        [
          "server-b",
          {
            transport: { close: closeB },
          },
        ],
      ])
    );

    await mcpClient.disconnect();

    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(mcpClient.hasConnections()).toBe(false);
  });

  it("disconnectServer removes server even when transport close fails", async () => {
    const mcpClient = new MCPClient(false);
    const close = jest.fn().mockRejectedValue(new Error("close failed"));
    setServers(
      mcpClient,
      new Map([
        [
          "server-1",
          {
            transport: { close },
          },
        ],
      ])
    );

    await expect(mcpClient.disconnectServer("server-1")).rejects.toThrow(
      "close failed"
    );
    expect(mcpClient.hasConnections()).toBe(false);
  });

  it("disconnect continues closing remaining servers on failure", async () => {
    const mcpClient = new MCPClient(false);
    const closeA = jest.fn().mockRejectedValue(new Error("close A failed"));
    const closeB = jest.fn().mockResolvedValue(undefined);
    setServers(
      mcpClient,
      new Map([
        [
          "server-a",
          {
            transport: { close: closeA },
          },
        ],
        [
          "server-b",
          {
            transport: { close: closeB },
          },
        ],
      ])
    );
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      await mcpClient.disconnect();
      expect(closeA).toHaveBeenCalledTimes(1);
      expect(closeB).toHaveBeenCalledTimes(1);
      expect(mcpClient.hasConnections()).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        "Failed to disconnect MCP server server-a: close A failed"
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("disconnect formats non-Error close failures", async () => {
    const mcpClient = new MCPClient(false);
    const closeA = jest.fn().mockRejectedValue({ reason: "close object failed" });
    setServers(
      mcpClient,
      new Map([
        [
          "server-a",
          {
            transport: { close: closeA },
          },
        ],
      ])
    );
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      await mcpClient.disconnect();
      expect(errorSpy).toHaveBeenCalledWith(
        'Failed to disconnect MCP server server-a: {"reason":"close object failed"}'
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
