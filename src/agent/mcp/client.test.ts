import {
  MCPClient,
  normalizeDiscoveredMCPTools,
  normalizeMCPListToolsPayload,
  normalizeMCPToolDescription,
  normalizeMCPToolParams,
  stringifyMCPPayload,
} from "@/agent/mcp/client";
import { MCPServerConfig } from "@/types/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Tool } from "@modelcontextprotocol/sdk/types";

function setServersForClient(client: MCPClient, servers: Map<string, unknown>): void {
  (client as unknown as { servers: Map<string, unknown> }).servers = servers;
}

function createTool(name: string): Tool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object", properties: {} },
  } as Tool;
}

describe("normalizeDiscoveredMCPTools", () => {
  it("normalizes discovered tool names and applies include filtering", () => {
    const normalized = normalizeDiscoveredMCPTools(
      [createTool(" search "), createTool("notes")],
      { includeTools: ["search"] }
    );
    expect(normalized.map((entry) => entry.normalizedName)).toEqual(["search"]);
  });

  it("applies include filtering case-insensitively", () => {
    const normalized = normalizeDiscoveredMCPTools(
      [createTool("search"), createTool("notes")],
      { includeTools: ["Search"] }
    );
    expect(normalized.map((entry) => entry.normalizedName)).toEqual(["search"]);
  });

  it("applies exclude filtering after normalization", () => {
    const normalized = normalizeDiscoveredMCPTools(
      [createTool("search"), createTool(" notes ")],
      { excludeTools: ["notes"] }
    );
    expect(normalized.map((entry) => entry.normalizedName)).toEqual(["search"]);
  });

  it("applies exclude filtering case-insensitively", () => {
    const normalized = normalizeDiscoveredMCPTools(
      [createTool("Search"), createTool("notes")],
      { excludeTools: ["search"] }
    );
    expect(normalized.map((entry) => entry.normalizedName)).toEqual(["notes"]);
  });

  it("rejects duplicate discovered tool names after normalization", () => {
    expect(() =>
      normalizeDiscoveredMCPTools(
        [createTool("search"), createTool(" search ")],
        {}
      )
    ).toThrow('MCP server returned duplicate tool name "search"');
  });

  it("rejects case-variant discovered tool names after normalization", () => {
    expect(() =>
      normalizeDiscoveredMCPTools(
        [createTool("Search"), createTool("search")],
        {}
      )
    ).toThrow(
      'MCP server returned duplicate tool name "search" after case normalization (conflicts with "Search")'
    );
  });

  it("rejects discovered tool names with unsupported control characters", () => {
    expect(() =>
      normalizeDiscoveredMCPTools([createTool("sea\nrch")], {})
    ).toThrow("MCP tool name contains unsupported control characters");
  });

  it("rejects discovered tools with non-string names", () => {
    expect(() =>
      normalizeDiscoveredMCPTools(
        [
          {
            description: "bad tool",
            inputSchema: { type: "object", properties: {} },
          } as unknown as Tool,
        ],
        {}
      )
    ).toThrow("MCP tool name must be a string");
  });

  it("throws actionable error when includeTools filter matches nothing", () => {
    expect(() =>
      normalizeDiscoveredMCPTools([createTool("search"), createTool("notes")], {
        includeTools: ["calendar"],
      })
    ).toThrow(
      "No MCP tools matched includeTools filter (calendar). Available tools: search, notes."
    );
  });

  it("truncates includeTools mismatch diagnostics for large tool sets", () => {
    const tools = Array.from({ length: 14 }, (_, index) =>
      createTool(`tool-${index}`)
    );
    const includeTools = Array.from({ length: 12 }, (_, index) => `missing-${index}`);
    expect(() =>
      normalizeDiscoveredMCPTools(tools, {
        includeTools,
      })
    ).toThrow(
      "No MCP tools matched includeTools filter (missing-0, missing-1, missing-2, missing-3, missing-4, missing-5, missing-6, missing-7, missing-8, missing-9, ... (+2 more)). Available tools: tool-0, tool-1, tool-2, tool-3, tool-4, tool-5, tool-6, tool-7, tool-8, tool-9, ... (+4 more)."
    );
  });

  it("rejects duplicate includeTools entries after normalization", () => {
    expect(() =>
      normalizeDiscoveredMCPTools([createTool("search")], {
        includeTools: ["search", " Search "],
      })
    ).toThrow(
      'MCP includeTools contains duplicate tool name "Search" after normalization'
    );
  });

  it("rejects overlapping includeTools and excludeTools entries", () => {
    expect(() =>
      normalizeDiscoveredMCPTools([createTool("search"), createTool("notes")], {
        includeTools: ["search"],
        excludeTools: [" Search "],
      })
    ).toThrow("MCP includeTools and excludeTools overlap on: Search");
  });
});

describe("normalizeMCPListToolsPayload", () => {
  it("returns tools array when payload shape is valid", () => {
    const tools = [createTool("search"), createTool("notes")];
    expect(normalizeMCPListToolsPayload({ tools })).toEqual(tools);
  });

  it("rejects payloads without a tools array", () => {
    expect(() => normalizeMCPListToolsPayload({})).toThrow(
      "Invalid MCP listTools response: expected a tools array"
    );
  });

  it("rejects oversized tools payloads", () => {
    const tools = Array.from({ length: 501 }, (_, index) =>
      createTool(`tool-${index}`)
    );
    expect(() => normalizeMCPListToolsPayload({ tools })).toThrow(
      "Invalid MCP listTools response: received more than 500 tools"
    );
  });

  it("rejects non-object tool entries", () => {
    expect(() =>
      normalizeMCPListToolsPayload({
        tools: [createTool("search"), "bad-entry"],
      })
    ).toThrow(
      "Invalid MCP listTools response: each tool entry must be an object"
    );
  });
});

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

  it("normalizes internal key whitespace before forwarding params", () => {
    expect(
      normalizeMCPToolParams({
        " user   id ": "42",
      })
    ).toEqual({
      "user id": "42",
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

  it("rejects non-object params at the root level for direct inputs", () => {
    expect(() =>
      normalizeMCPToolParams(42 as unknown as Record<string, unknown>)
    ).toThrow("MCP tool params must be a JSON object at the root level");
  });

  it("rejects array params at the root level for direct inputs", () => {
    expect(() =>
      normalizeMCPToolParams([] as unknown as Record<string, unknown>)
    ).toThrow("MCP tool params must be a JSON object at the root level");
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

  it("rejects keys with newline characters", () => {
    expect(() =>
      normalizeMCPToolParams({
        "bad\nkey": "value",
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

  it("rejects oversized non-plain object diagnostic values", () => {
    class CustomPayload {
      payload = "x".repeat(20_500);
    }

    expect(() =>
      normalizeMCPToolParams({
        metadata: new CustomPayload() as unknown as Record<string, unknown>,
      })
    ).toThrow(
      "MCP tool params cannot include string values longer than 20000 characters"
    );
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

  it("rejects duplicate map keys after collapsing internal whitespace", () => {
    const map = new Map<unknown, unknown>([
      ["user   id", "first"],
      ["user id", "second"],
    ]);
    expect(() =>
      normalizeMCPToolParams({
        metadata: map as unknown as Record<string, unknown>,
      })
    ).toThrow(
      'MCP tool params cannot include duplicate key after trimming: "user id"'
    );
  });

  it("rejects map keys with newline characters", () => {
    const map = new Map<unknown, unknown>([["bad\nkey", "value"]]);
    expect(() =>
      normalizeMCPToolParams({
        metadata: map as unknown as Record<string, unknown>,
      })
    ).toThrow("MCP tool params cannot include keys with control characters");
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

  it("rejects duplicate keys after collapsing internal whitespace", () => {
    expect(() =>
      normalizeMCPToolParams({
        "user   id": "weather",
        "user id": "finance",
      })
    ).toThrow(
      'MCP tool params cannot include duplicate key after trimming: "user id"'
    );
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

describe("normalizeMCPToolDescription", () => {
  it("returns empty description for non-string values", () => {
    expect(normalizeMCPToolDescription(undefined)).toBe("");
    expect(normalizeMCPToolDescription(42)).toBe("");
  });

  it("sanitizes control characters and collapses whitespace", () => {
    expect(normalizeMCPToolDescription(" hello\n\tworld\u0007 ")).toBe(
      "hello world"
    );
  });

  it("truncates oversized tool descriptions", () => {
    const normalized = normalizeMCPToolDescription(`tool ${"x".repeat(2_100)}`);
    expect(normalized).toContain("[truncated");
    expect(normalized.length).toBeLessThan(2_100);
  });
});

describe("MCPClient.connectToServer validation", () => {
  it("closes pending transport when connection fails after connect", async () => {
    const connectSpy = jest
      .spyOn(Client.prototype, "connect")
      .mockResolvedValue(undefined);
    const listToolsSpy = jest
      .spyOn(Client.prototype, "listTools")
      .mockRejectedValue(new Error("listTools failed"));
    const closeSpy = jest
      .spyOn(StdioClientTransport.prototype, "close")
      .mockResolvedValue(undefined);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const mcpClient = new MCPClient(false);

    try {
      await expect(
        mcpClient.connectToServer({
          command: "npx",
        })
      ).rejects.toThrow("listTools failed");
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      connectSpy.mockRestore();
      listToolsSpy.mockRestore();
      closeSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("rejects non-object server configs", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer(null as unknown as MCPServerConfig)
      ).rejects.toThrow("MCP server config must be an object");
      await expect(
        mcpClient.connectToServer([] as unknown as MCPServerConfig)
      ).rejects.toThrow("MCP server config must be an object");
    } finally {
      errorSpy.mockRestore();
    }
  });

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

  it("rejects duplicate server id matches case-insensitively", async () => {
    const mcpClient = new MCPClient(false);
    setServersForClient(
      mcpClient,
      new Map([
        [
          "Server-1",
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
          id: " server-1 ",
          command: "echo",
        })
      ).rejects.toThrow('MCP server with ID "server-1" is already connected');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects blank server ids when provided programmatically", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          id: "   ",
          command: "echo",
        })
      ).rejects.toThrow("MCP server id must be a non-empty string when provided");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects non-string server ids when provided programmatically", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          id: 42 as unknown as string,
          command: "echo",
        })
      ).rejects.toThrow("MCP server id must be a string when provided");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects server ids with control characters", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          id: "server\n1",
          command: "echo",
        })
      ).rejects.toThrow("MCP server id contains unsupported control characters");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects oversized server ids", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          id: `server-${"x".repeat(130)}`,
          command: "echo",
        })
      ).rejects.toThrow("MCP server id exceeds 128 characters");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects invalid connectionType values", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          command: "echo",
          connectionType: " websocket " as unknown as "stdio",
        })
      ).rejects.toThrow(
        'MCP connectionType must be either "stdio" or "sse" when provided'
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects non-string connectionType values", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          command: "echo",
          connectionType: 1 as unknown as "stdio",
        })
      ).rejects.toThrow(
        'MCP connectionType must be either "stdio" or "sse" when provided'
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("normalizes connectionType casing and spacing before validation", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          connectionType: "  SsE  " as unknown as "sse",
        })
      ).rejects.toThrow("SSE URL is required for SSE connection type");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("infers SSE connection type when only sseUrl is provided", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          sseUrl: "ftp://example.com/events",
        })
      ).rejects.toThrow("SSE URL must use http:// or https://");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects mixed stdio and SSE fields when connection type is implicit", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          command: "npx",
          sseUrl: "https://example.com/events",
        })
      ).rejects.toThrow(
        "MCP config mixes stdio and sse fields. Set connectionType and provide only matching fields."
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects stdio connections that include SSE-only fields", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          connectionType: "stdio",
          command: "npx",
          sseHeaders: {
            Authorization: "Bearer token",
          },
        })
      ).rejects.toThrow(
        "MCP stdio connection cannot include sse fields: sseHeaders"
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects stdio connections that include empty SSE header objects", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          connectionType: "stdio",
          command: "npx",
          sseHeaders: {},
        })
      ).rejects.toThrow(
        "MCP stdio connection cannot include sse fields: sseHeaders"
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects SSE connections that include stdio-only fields", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          connectionType: "sse",
          sseUrl: "https://example.com/events",
          command: "npx",
        })
      ).rejects.toThrow(
        "MCP SSE connection cannot include stdio fields: command"
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects SSE connections that include empty stdio args", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          connectionType: "sse",
          sseUrl: "https://example.com/events",
          args: [],
        })
      ).rejects.toThrow(
        "MCP SSE connection cannot include stdio fields: args"
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects SSE connections that include empty env records", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          connectionType: "sse",
          sseUrl: "https://example.com/events",
          env: {},
        })
      ).rejects.toThrow(
        "MCP SSE connection cannot include stdio fields: env"
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects stdio command values that are blank after trimming", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          command: "   ",
        })
      ).rejects.toThrow("Command is required for stdio connection type");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects stdio command values with control characters", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          command: "np\nx",
        })
      ).rejects.toThrow("MCP command contains unsupported control characters");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects oversized stdio command values", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          command: `x${"a".repeat(2_100)}`,
        })
      ).rejects.toThrow("MCP command exceeds 2048 characters");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects non-array command args", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          command: "npx",
          args: "invalid" as unknown as string[],
        })
      ).rejects.toThrow("MCP command args must be an array of non-empty strings");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects command args with blank entries after trimming", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          command: "npx",
          args: ["   "],
        })
      ).rejects.toThrow("MCP command args must be an array of non-empty strings");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects command args with control characters", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          command: "npx",
          args: ["bad\narg"],
        })
      ).rejects.toThrow("MCP command args contain unsupported control characters");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects oversized command args", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          command: "npx",
          args: ["x".repeat(4_001)],
        })
      ).rejects.toThrow(
        "MCP command args cannot include entries longer than 4000 characters"
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects command args with too many entries", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          command: "npx",
          args: Array.from({ length: 101 }, (_, index) => `arg-${index}`),
        })
      ).rejects.toThrow(
        "MCP command args cannot contain more than 100 entries"
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects non-object env records", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          command: "npx",
          env: "invalid" as unknown as Record<string, string>,
        })
      ).rejects.toThrow("MCP env must be an object of string key/value pairs");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects invalid env record entries", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          command: "npx",
          env: {
            constructor: "bad",
          },
        })
      ).rejects.toThrow("MCP env must be an object of string key/value pairs");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects oversized env records", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const env = Object.fromEntries(
      Array.from({ length: 201 }, (_, index) => [`KEY_${index}`, "value"])
    );
    try {
      await expect(
        mcpClient.connectToServer({
          command: "npx",
          env,
        })
      ).rejects.toThrow("MCP env cannot include more than 200 entries");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects invalid SSE header records", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          connectionType: "sse",
          sseUrl: "https://example.com/stream",
          sseHeaders: {
            "Bad Header": "value",
          },
        })
      ).rejects.toThrow(
        "MCP sseHeaders must be an object of string key/value pairs"
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects duplicate SSE header keys after normalization", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          connectionType: "sse",
          sseUrl: "https://example.com/stream",
          sseHeaders: {
            " X-Test ": "one",
            "x-test": "two",
          },
        })
      ).rejects.toThrow('MCP sseHeaders contains duplicate key "x-test"');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects SSE URLs with unsupported protocols", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          connectionType: "sse",
          sseUrl: "ftp://example.com/events",
        })
      ).rejects.toThrow("SSE URL must use http:// or https://");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects SSE URLs with control characters", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          connectionType: "sse",
          sseUrl: "https://example.com/\nstream",
        })
      ).rejects.toThrow("SSE URL contains unsupported control characters");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects oversized SSE URL values", async () => {
    const mcpClient = new MCPClient(false);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mcpClient.connectToServer({
          connectionType: "sse",
          sseUrl: `https://example.com/${"a".repeat(4_100)}`,
        })
      ).rejects.toThrow("SSE URL exceeds 4000 characters");
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

  it("normalizes JSON-string executeTool parameters before forwarding", async () => {
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

    await mcpClient.executeTool("search", '{"query":"weather"}');

    expect(callTool).toHaveBeenCalledWith({
      name: "search",
      arguments: { query: "weather" },
    });
  });

  it("rejects invalid executeTool parameter payloads before dispatch", async () => {
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

    await expect(
      mcpClient.executeTool("search", "[1,2,3]")
    ).rejects.toThrow("must parse to a JSON object");
    expect(callTool).not.toHaveBeenCalled();
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

  it("trims provided serverId before server lookup", async () => {
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

    await mcpClient.executeTool("search", { query: "weather" }, "  server-1  ");

    expect(callTool).toHaveBeenCalledWith({
      name: "search",
      arguments: { query: "weather" },
    });
  });

  it("matches provided serverId case-insensitively", async () => {
    const mcpClient = new MCPClient(false);
    const callTool = jest.fn().mockResolvedValue({ content: [] });
    setServers(
      mcpClient,
      new Map([
        [
          "Server-1",
          {
            tools: new Map([["search", {}]]),
            client: { callTool },
          },
        ],
      ])
    );

    await mcpClient.executeTool("search", { query: "weather" }, "server-1");

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

  it("matches tool names case-insensitively within a server", async () => {
    const mcpClient = new MCPClient(false);
    const callTool = jest.fn().mockResolvedValue({ content: [] });
    setServers(
      mcpClient,
      new Map([
        [
          "server-a",
          {
            tools: new Map([["Search", createTool("Search")]]),
            client: { callTool },
          },
        ],
      ])
    );

    await mcpClient.executeTool("search", { query: "coffee" }, "server-a");

    expect(callTool).toHaveBeenCalledWith({
      name: "Search",
      arguments: { query: "coffee" },
    });
  });

  it("rejects case-insensitive tool lookups that are ambiguous on a server", async () => {
    const mcpClient = new MCPClient(false);
    const callTool = jest.fn();
    setServers(
      mcpClient,
      new Map([
        [
          "server-a",
          {
            tools: new Map([
              ["Search", createTool("Search")],
              ["search", createTool("search")],
            ]),
            client: { callTool },
          },
        ],
      ])
    );

    await expect(
      mcpClient.executeTool("SEARCH", { query: "coffee" }, "server-a")
    ).rejects.toThrow(
      'Tool "SEARCH" matches multiple tools on server "server-a" (Search, search). Use exact tool name.'
    );
    expect(callTool).not.toHaveBeenCalled();
  });

  it("uses original discovered tool name when calling MCP server", async () => {
    const mcpClient = new MCPClient(false);
    const callTool = jest.fn().mockResolvedValue({ content: [] });
    setServers(
      mcpClient,
      new Map([
        [
          "server-1",
          {
            tools: new Map([["search", createTool(" search ")]]),
            client: { callTool },
          },
        ],
      ])
    );

    await mcpClient.executeTool("search", { query: "weather" }, "server-1");

    expect(callTool).toHaveBeenCalledWith({
      name: " search ",
      arguments: { query: "weather" },
    });
  });

  it("throws clear error when multiple servers expose same tool and serverId is omitted", async () => {
    const mcpClient = new MCPClient(false);
    const firstCallTool = jest.fn().mockResolvedValue({ content: [] });
    const secondCallTool = jest.fn().mockResolvedValue({ content: [] });
    setServers(
      mcpClient,
      new Map([
        [
          "server-a",
          {
            tools: new Map([["search", {}]]),
            client: { callTool: firstCallTool },
          },
        ],
        [
          "server-b",
          {
            tools: new Map([["search", {}]]),
            client: { callTool: secondCallTool },
          },
        ],
      ])
    );

    await expect(mcpClient.executeTool("search", { query: "coffee" })).rejects
      .toThrow(
        'Tool "search" is registered on multiple servers (server-a, server-b). Provide serverId explicitly.'
      );
    expect(firstCallTool).not.toHaveBeenCalled();
    expect(secondCallTool).not.toHaveBeenCalled();
  });

  it("truncates ambiguous-server diagnostics when many servers match", async () => {
    const mcpClient = new MCPClient(false);
    const servers = new Map<
      string,
      {
        tools: Map<string, unknown>;
        client: { callTool: jest.Mock };
      }
    >();
    for (let index = 0; index < 7; index += 1) {
      servers.set(`server-${index}`, {
        tools: new Map([["search", {}]]),
        client: { callTool: jest.fn().mockResolvedValue({ content: [] }) },
      });
    }
    setServers(mcpClient, servers);

    await expect(mcpClient.executeTool("search", { query: "coffee" })).rejects
      .toThrow(
        'Tool "search" is registered on multiple servers (server-0, server-1, server-2, server-3, server-4, ... (+2 more)). Provide serverId explicitly.'
      );
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

  it("rejects empty tool names before server lookup", async () => {
    const mcpClient = new MCPClient(false);
    await expect(
      mcpClient.executeTool("   ", { query: "missing" }, "unknown-server")
    ).rejects.toThrow("MCP tool name must be a non-empty string");
  });

  it("rejects non-string tool names before server lookup", async () => {
    const mcpClient = new MCPClient(false);
    await expect(
      mcpClient.executeTool(
        42 as unknown as string,
        { query: "missing" },
        "unknown-server"
      )
    ).rejects.toThrow("MCP tool name must be a string");
  });

  it("rejects tool names with control characters", async () => {
    const mcpClient = new MCPClient(false);
    await expect(
      mcpClient.executeTool("sea\nrch", { query: "missing" }, "unknown-server")
    ).rejects.toThrow("MCP tool name contains unsupported control characters");
  });

  it("rejects server ids with control characters", async () => {
    const mcpClient = new MCPClient(false);
    await expect(
      mcpClient.executeTool("search", { query: "missing" }, "server\n-a")
    ).rejects.toThrow("MCP serverId contains unsupported control characters");
  });

  it("rejects non-string server ids before lookup", async () => {
    const mcpClient = new MCPClient(false);
    await expect(
      mcpClient.executeTool(
        "search",
        { query: "missing" },
        42 as unknown as string
      )
    ).rejects.toThrow("MCP serverId must be a string when provided");
  });

  it("rejects oversized server ids before lookup", async () => {
    const mcpClient = new MCPClient(false);
    await expect(
      mcpClient.executeTool(
        "search",
        { query: "missing" },
        `server-${"x".repeat(300)}`
      )
    ).rejects.toThrow("MCP serverId exceeds 256 characters");
  });

  it("sanitizes tool identifiers in missing-server errors", async () => {
    const mcpClient = new MCPClient(false);
    const noisyToolName = `bad-${"x".repeat(200)}`;
    expect.assertions(3);
    try {
      await mcpClient.executeTool(
        noisyToolName,
        { query: "missing" },
        "unknown-server"
      );
      throw new Error("Expected executeTool to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("No valid server found for tool");
      expect(message).not.toContain("\n");
      expect(message).toContain("[truncated]");
    }
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

  it("sanitizes tool names in missing-tool diagnostics", async () => {
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

    expect.assertions(4);
    try {
      await mcpClient.executeTool(
        `search-${"x".repeat(200)}`,
        { query: "missing" },
        "server-a"
      );
      throw new Error("Expected executeTool to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('Tool "search-');
      expect(message).toContain('[truncated]" is not registered on server "server-a"');
      expect(message).not.toContain("\n");
    }
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

  it("disconnectServer resolves server id case-insensitively", async () => {
    const mcpClient = new MCPClient(false);
    const close = jest.fn().mockResolvedValue(undefined);
    setServers(
      mcpClient,
      new Map([
        [
          "Server-1",
          {
            transport: { close },
          },
        ],
      ])
    );

    await mcpClient.disconnectServer(" server-1 ");

    expect(close).toHaveBeenCalledTimes(1);
    expect(mcpClient.getServerIds()).toEqual([]);
  });

  it("disconnectServer ignores invalid server id inputs", async () => {
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

    await mcpClient.disconnectServer("   ");
    await mcpClient.disconnectServer("bad\nid");

    expect(close).not.toHaveBeenCalled();
    expect(mcpClient.getServerIds()).toEqual(["server-1"]);
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

  it("disconnectServer wraps non-Error close failures", async () => {
    const mcpClient = new MCPClient(false);
    const close = jest.fn().mockRejectedValue({ reason: "close object failed" });
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
      '{"reason":"close object failed"}'
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

describe("MCPClient.hasTool", () => {
  function setServers(
    client: MCPClient,
    servers: Map<
      string,
      {
        tools: Map<string, unknown>;
      }
    >
  ): void {
    setServersForClient(
      client,
      servers as unknown as Map<string, unknown>
    );
  }

  it("returns normalized lookup result for matching tool names", () => {
    const mcpClient = new MCPClient(false);
    setServers(
      mcpClient,
      new Map([
        [
          "server-a",
          {
            tools: new Map([["search", {}]]),
          },
        ],
      ])
    );

    expect(mcpClient.hasTool("  search  ")).toEqual({
      exists: true,
      serverId: "server-a",
    });
  });

  it("matches tool names case-insensitively for lookup", () => {
    const mcpClient = new MCPClient(false);
    setServers(
      mcpClient,
      new Map([
        [
          "server-a",
          {
            tools: new Map([["Search", {}]]),
          },
        ],
      ])
    );

    expect(mcpClient.hasTool("search")).toEqual({
      exists: true,
      serverId: "server-a",
    });
  });

  it("returns ambiguity details when multiple servers expose same tool", () => {
    const mcpClient = new MCPClient(false);
    setServers(
      mcpClient,
      new Map([
        [
          "server-a",
          {
            tools: new Map([["search", {}]]),
          },
        ],
        [
          "server-b",
          {
            tools: new Map([["search", {}]]),
          },
        ],
      ])
    );

    expect(mcpClient.hasTool("search")).toEqual({
      exists: true,
      serverId: "server-a",
      serverIds: ["server-a", "server-b"],
      isAmbiguous: true,
    });
  });

  it("returns ambiguity details for case-insensitive collisions on one server", () => {
    const mcpClient = new MCPClient(false);
    setServers(
      mcpClient,
      new Map([
        [
          "server-a",
          {
            tools: new Map([
              ["Search", {}],
              ["search", {}],
            ]),
          },
        ],
      ])
    );

    expect(mcpClient.hasTool("SEARCH")).toEqual({
      exists: true,
      serverId: "server-a",
      serverIds: ["server-a"],
      isAmbiguous: true,
    });
  });

  it("returns exists false when no matching tool exists", () => {
    const mcpClient = new MCPClient(false);
    setServers(
      mcpClient,
      new Map([
        [
          "server-a",
          {
            tools: new Map([["notes", {}]]),
          },
        ],
      ])
    );

    expect(mcpClient.hasTool("search")).toEqual({ exists: false });
  });

  it("returns exists false for invalid lookup inputs", () => {
    const mcpClient = new MCPClient(false);
    expect(mcpClient.hasTool("   ")).toEqual({ exists: false });
    expect(mcpClient.hasTool("sea\nrch")).toEqual({ exists: false });
  });
});
