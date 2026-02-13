import {
  MCPClient,
  normalizeMCPToolParams,
  stringifyMCPPayload,
} from "@/agent/mcp/client";

function setServersForClient(client: MCPClient, servers: Map<string, unknown>): void {
  (client as unknown as { servers: Map<string, unknown> }).servers = servers;
}

describe("normalizeMCPToolParams", () => {
  it("returns object inputs unchanged", () => {
    const input = { query: "laptops", limit: 5 };
    expect(normalizeMCPToolParams(input)).toEqual(input);
  });

  it("trims parameter keys before forwarding to tool execution", () => {
    expect(
      normalizeMCPToolParams({
        "  query  ": "weather",
      })
    ).toEqual({
      query: "weather",
    });
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

  it("throws clear error for empty JSON strings", () => {
    expect(() => normalizeMCPToolParams("   ")).toThrow(
      "Invalid MCP tool params JSON string: input is empty"
    );
  });

  it("throws when parsed JSON is not an object", () => {
    expect(() => normalizeMCPToolParams("[1,2,3]")).toThrow(
      "must parse to a JSON object"
    );
  });

  it("rejects oversized JSON string params before parsing", () => {
    const oversized = `{"data":"${"x".repeat(100_010)}"}`;
    expect(() => normalizeMCPToolParams(oversized)).toThrow(
      "Invalid MCP tool params JSON string: exceeds 100000 characters"
    );
  });

  it("rejects JSON string params with unsupported control characters", () => {
    expect(() => normalizeMCPToolParams("{\"query\":\"a\u0007b\"}")).toThrow(
      "Invalid MCP tool params JSON string: contains unsupported control characters"
    );
  });

  it("rejects reserved object keys in parsed JSON params", () => {
    expect(() => normalizeMCPToolParams('{"__proto__":{"x":1}}')).toThrow(
      'MCP tool params cannot include reserved key "__proto__"'
    );
  });

  it("rejects reserved object keys in direct object params", () => {
    expect(() =>
      normalizeMCPToolParams({
        constructor: "bad",
      })
    ).toThrow('MCP tool params cannot include reserved key "constructor"');
  });

  it("rejects reserved object keys nested inside payloads", () => {
    expect(() =>
      normalizeMCPToolParams('{"outer":{"__proto__":{"x":1}}}')
    ).toThrow('MCP tool params cannot include reserved key "__proto__"');
  });

  it("rejects keys with control characters", () => {
    expect(() =>
      normalizeMCPToolParams({
        "bad\u0007key": "value",
      })
    ).toThrow("MCP tool params cannot include keys with control characters");
  });

  it("rejects keys that exceed maximum length", () => {
    expect(() =>
      normalizeMCPToolParams({
        [String.raw`${"k".repeat(257)}`]: "value",
      })
    ).toThrow("MCP tool params cannot include keys longer than 256 characters");
  });

  it("rejects oversized object collections", () => {
    const oversized = Object.fromEntries(
      Array.from({ length: 501 }, (_, index) => [`k${index}`, index])
    );
    expect(() => normalizeMCPToolParams(oversized)).toThrow(
      "MCP tool params cannot include collections with more than 500 entries"
    );
  });

  it("rejects oversized array collections", () => {
    expect(() =>
      normalizeMCPToolParams({
        values: Array.from({ length: 501 }, (_, index) => index),
      })
    ).toThrow(
      "MCP tool params cannot include collections with more than 500 entries"
    );
  });

  it("rejects string values with control characters", () => {
    expect(() =>
      normalizeMCPToolParams({
        query: "a\u0007b",
      })
    ).toThrow(
      "MCP tool params cannot include unsupported control characters in string values"
    );
  });

  it("rejects non-finite number values in direct object params", () => {
    expect(() =>
      normalizeMCPToolParams({
        score: Number.NaN,
      })
    ).toThrow("MCP tool params cannot include non-finite number values");
  });

  it("rejects escaped control characters after JSON parsing", () => {
    expect(() =>
      normalizeMCPToolParams('{"query":"a\\u0007b"}')
    ).toThrow(
      "MCP tool params cannot include unsupported control characters in string values"
    );
  });

  it("rejects non-finite number values after JSON parsing", () => {
    expect(() =>
      normalizeMCPToolParams('{"score":1e309}')
    ).toThrow("MCP tool params cannot include non-finite number values");
  });

  it("rejects oversized string values in direct object params", () => {
    expect(() =>
      normalizeMCPToolParams({
        query: "x".repeat(20_001),
      })
    ).toThrow(
      "MCP tool params cannot include string values longer than 20000 characters"
    );
  });

  it("rejects oversized string values after JSON parsing", () => {
    expect(() =>
      normalizeMCPToolParams(`{"query":"${"x".repeat(20_001)}"}`)
    ).toThrow(
      "MCP tool params cannot include string values longer than 20000 characters"
    );
  });

  it("normalizes non-JSON primitive values in object params", () => {
    const token = Symbol("token");
    const sampleFunction = function sampleFunction(): void {
      // noop
    };

    expect(
      normalizeMCPToolParams({
        bigintValue: BigInt(42),
        symbolValue: token,
        functionValue: sampleFunction,
      })
    ).toEqual({
      bigintValue: "42n",
      symbolValue: "Symbol(token)",
      functionValue: "[Function sampleFunction]",
    });
  });

  it("normalizes Date, Map, and Set values safely", () => {
    const date = new Date("2025-01-01T00:00:00.000Z");
    const map = new Map([["key", "value"]]);
    const set = new Set(["alpha", 2]);

    expect(
      normalizeMCPToolParams({
        createdAt: date,
        metadata: map as unknown as Record<string, unknown>,
        tags: set as unknown as Record<string, unknown>,
      })
    ).toEqual({
      createdAt: "2025-01-01T00:00:00.000Z",
      metadata: { key: "value" },
      tags: ["alpha", 2],
    });
  });

  it("rejects duplicate keys when map keys collide after trimming", () => {
    const map = new Map<unknown, unknown>([
      [" key ", "first"],
      ["key", "second"],
    ]);
    expect(() =>
      normalizeMCPToolParams({
        metadata: map as unknown as Record<string, unknown>,
      })
    ).toThrow('MCP tool params cannot include duplicate key after trimming: "key"');
  });

  it("rejects map keys that exceed maximum length", () => {
    const map = new Map<unknown, unknown>([[`${"k".repeat(257)}`, "value"]]);
    expect(() =>
      normalizeMCPToolParams({
        metadata: map as unknown as Record<string, unknown>,
      })
    ).toThrow("MCP tool params cannot include keys longer than 256 characters");
  });

  it("rejects oversized map and set collections", () => {
    const oversizedMap = new Map<unknown, unknown>(
      Array.from({ length: 501 }, (_, index) => [`k${index}`, index])
    );
    const oversizedSet = new Set(Array.from({ length: 501 }, (_, index) => index));

    expect(() =>
      normalizeMCPToolParams({
        metadata: oversizedMap as unknown as Record<string, unknown>,
      })
    ).toThrow(
      "MCP tool params cannot include collections with more than 500 entries"
    );
    expect(() =>
      normalizeMCPToolParams({
        values: oversizedSet as unknown as Record<string, unknown>,
      })
    ).toThrow(
      "MCP tool params cannot include collections with more than 500 entries"
    );
  });

  it("rejects circular references in direct object params", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => normalizeMCPToolParams(circular)).toThrow(
      "MCP tool params cannot include circular references"
    );
  });

  it("rejects circular references in array params", () => {
    const circularArray: unknown[] = [];
    circularArray.push(circularArray);
    expect(() =>
      normalizeMCPToolParams({
        items: circularArray,
      })
    ).toThrow("MCP tool params cannot include circular references");
  });

  it("rejects reserved keys case-insensitively after trimming", () => {
    expect(() =>
      normalizeMCPToolParams({
        "  Constructor  ": "bad",
      })
    ).toThrow('MCP tool params cannot include reserved key "  Constructor  "');
  });

  it("rejects empty keys after trimming", () => {
    expect(() =>
      normalizeMCPToolParams({
        "   ": "bad",
      })
    ).toThrow("MCP tool params cannot include empty keys");
  });

  it("rejects duplicate keys after trimming", () => {
    expect(() =>
      normalizeMCPToolParams({
        query: "weather",
        " query ": "finance",
      })
    ).toThrow('MCP tool params cannot include duplicate key after trimming: "query"');
  });

  it("rejects params that exceed maximum nesting depth", () => {
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let depth = 0; depth < 35; depth += 1) {
      cursor.child = {};
      cursor = cursor.child as Record<string, unknown>;
    }

    expect(() =>
      normalizeMCPToolParams({
        payload: root,
      })
    ).toThrow("MCP tool params exceed maximum nesting depth of 25");
  });

  it("allows repeated shared object references across sibling fields", () => {
    const shared = { query: "weather" };
    expect(
      normalizeMCPToolParams({
        first: shared,
        second: shared,
      })
    ).toEqual({
      first: { query: "weather" },
      second: { query: "weather" },
    });
  });
});

describe("stringifyMCPPayload", () => {
  it("serializes plain objects to JSON", () => {
    expect(stringifyMCPPayload({ ok: true })).toBe('{"ok":true}');
  });

  it("falls back to formatted unknown error for circular payloads", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(stringifyMCPPayload(circular)).toBe('{"self":"[Circular]"}');
  });

  it("truncates oversized payload strings to bounded length", () => {
    const payload = { text: "x".repeat(5000) };
    const output = stringifyMCPPayload(payload);
    expect(output).toContain("[truncated]");
    expect(output.length).toBeLessThanOrEqual(4016);
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
      expect(errorSpy).toHaveBeenCalledWith(
        'Failed to connect to MCP server: MCP server with ID "server-1" is already connected'
      );
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
