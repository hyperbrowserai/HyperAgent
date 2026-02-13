import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadMCPServersFromFile,
  parseMCPServersConfig,
} from "@/cli/mcp-config";

describe("parseMCPServersConfig", () => {
  it("parses array-formatted config", () => {
    const parsed = parseMCPServersConfig(
      '[{"id":"one","command":"npx","args":["-y","server"]}]'
    );
    expect(parsed).toEqual([
      {
        id: "one",
        command: "npx",
        args: ["-y", "server"],
        connectionType: "stdio",
      },
    ]);
  });

  it("parses object config with servers array", () => {
    const parsed = parseMCPServersConfig(
      '{"servers":[{"id":"one","connectionType":"sse","sseUrl":"https://example.com/sse"}]}'
    );
    expect(parsed).toEqual([
      {
        id: "one",
        connectionType: "sse",
        sseUrl: "https://example.com/sse",
      },
    ]);
  });

  it("parses config content with BOM and surrounding whitespace", () => {
    const parsed = parseMCPServersConfig(
      "  \n\uFEFF[{\"command\":\"npx\",\"args\":[\"-y\"]}]  \n"
    );
    expect(parsed).toEqual([
      {
        command: "npx",
        args: ["-y"],
        connectionType: "stdio",
      },
    ]);
  });

  it("throws clear message for invalid JSON", () => {
    expect(() => parseMCPServersConfig("{broken")).toThrow(
      "Invalid MCP config JSON"
    );
  });

  it("throws clear message when config contains null bytes", () => {
    expect(() => parseMCPServersConfig("\u0000[]")).toThrow(
      "Invalid MCP config JSON: config appears to be binary or contains null bytes."
    );
  });

  it("throws clear message when config contains unsupported control characters", () => {
    expect(() => parseMCPServersConfig("\u0007[]")).toThrow(
      "Invalid MCP config JSON: config contains unsupported control characters."
    );
  });

  it("throws when raw config exceeds maximum allowed size", () => {
    expect(() => parseMCPServersConfig("x".repeat(1_000_001))).toThrow(
      "Invalid MCP config JSON: config exceeds 1000000 characters."
    );
  });

  it("throws when payload is not servers-shaped", () => {
    expect(() => parseMCPServersConfig('{"foo":1}')).toThrow(
      'MCP config must be a JSON array or an object with a "servers" array.'
    );
  });

  it("throws when config contains no server entries", () => {
    expect(() => parseMCPServersConfig("[]")).toThrow(
      "MCP config must include at least one server entry."
    );
    expect(() => parseMCPServersConfig('{"servers":[]}')).toThrow(
      "MCP config must include at least one server entry."
    );
  });

  it("throws when server entries are not objects", () => {
    expect(() => parseMCPServersConfig("[1]")).toThrow(
      "MCP server entry at index 0 must be an object."
    );
  });

  it("throws when stdio server command is missing or blank", () => {
    expect(() => parseMCPServersConfig('[{"connectionType":"stdio"}]')).toThrow(
      'MCP server entry at index 0 must include a non-empty "command" for stdio connections.'
    );
    expect(() =>
      parseMCPServersConfig('[{"connectionType":"stdio","command":"   "}]')
    ).toThrow(
      'MCP server entry at index 0 must include a non-empty "command" for stdio connections.'
    );
  });

  it("throws when sse server sseUrl is missing or blank", () => {
    expect(() => parseMCPServersConfig('[{"connectionType":"sse"}]')).toThrow(
      'MCP server entry at index 0 must include a non-empty "sseUrl" for SSE connections.'
    );
    expect(() =>
      parseMCPServersConfig('[{"connectionType":"sse","sseUrl":"   "}]')
    ).toThrow(
      'MCP server entry at index 0 must include a non-empty "sseUrl" for SSE connections.'
    );
  });

  it("throws when duplicate non-empty server IDs are declared", () => {
    expect(() =>
      parseMCPServersConfig(
        '[{"id":"shared","command":"npx"},{"id":"shared","command":"node"}]'
      )
    ).toThrow('MCP server entry at index 1 reuses duplicate id "shared".');
  });

  it("rejects duplicate server IDs case-insensitively", () => {
    expect(() =>
      parseMCPServersConfig(
        '[{"id":"Server-A","command":"npx"},{"id":"server-a","command":"node"}]'
      )
    ).toThrow('MCP server entry at index 1 reuses duplicate id "server-a".');
  });

  it("throws when id or connectionType types are invalid", () => {
    expect(() =>
      parseMCPServersConfig('[{"id":123,"command":"npx"}]')
    ).toThrow(
      'MCP server entry at index 0 must provide "id" as a string when specified.'
    );

    expect(() =>
      parseMCPServersConfig('[{"connectionType":123,"command":"npx"}]')
    ).toThrow(
      'MCP server entry at index 0 must provide "connectionType" as a string when specified.'
    );
  });

  it("returns normalized trimmed id/command/sseUrl fields", () => {
    const parsed = parseMCPServersConfig(
      '[{"id":"  stdio-1  ","command":"  npx  ","includeTools":["  search  ","lookup"],"excludeTools":[" notes " ]},{"connectionType":"sse","id":"  ","sseUrl":"  https://example.com/sse  "}]'
    );

    expect(parsed).toEqual([
      {
        id: "stdio-1",
        command: "npx",
        connectionType: "stdio",
        includeTools: ["search", "lookup"],
        excludeTools: ["notes"],
      },
      {
        connectionType: "sse",
        sseUrl: "https://example.com/sse",
      },
    ]);
  });

  it("throws when include/exclude tools are not non-empty string arrays", () => {
    expect(() =>
      parseMCPServersConfig(
        '[{"command":"npx","includeTools":"search"}]'
      )
    ).toThrow(
      'MCP server entry at index 0 must provide "includeTools" as an array of non-empty strings.'
    );

    expect(() =>
      parseMCPServersConfig(
        '[{"command":"npx","excludeTools":["ok", "   "]}]'
      )
    ).toThrow(
      'MCP server entry at index 0 must provide "excludeTools" as an array of non-empty strings.'
    );
  });

  it("throws when include/exclude tool arrays contain duplicates after trimming", () => {
    expect(() =>
      parseMCPServersConfig(
        '[{"command":"npx","includeTools":[" search ","search"]}]'
      )
    ).toThrow(
      'MCP server entry at index 0 contains duplicate "includeTools" value "search" after trimming.'
    );

    expect(() =>
      parseMCPServersConfig(
        '[{"command":"npx","excludeTools":[" notes ","notes"]}]'
      )
    ).toThrow(
      'MCP server entry at index 0 contains duplicate "excludeTools" value "notes" after trimming.'
    );

    expect(() =>
      parseMCPServersConfig(
        '[{"command":"npx","includeTools":["Search","search"]}]'
      )
    ).toThrow(
      'MCP server entry at index 0 contains duplicate "includeTools" value "search" after trimming.'
    );
  });

  it("normalizes connectionType casing/whitespace and rejects unsupported values", () => {
    const parsed = parseMCPServersConfig(
      '[{"connectionType":"  SSE  ","sseUrl":"https://example.com/sse"}]'
    );
    expect(parsed[0]?.connectionType).toBe("sse");

    expect(() =>
      parseMCPServersConfig('[{"connectionType":"websocket","command":"npx"}]')
    ).toThrow(
      'MCP server entry at index 0 has unsupported connectionType "websocket". Supported values are "stdio" and "sse".'
    );
  });

  it("infers SSE connectionType when only sseUrl is provided", () => {
    const parsed = parseMCPServersConfig(
      '[{"sseUrl":"https://example.com/sse"}]'
    );
    expect(parsed).toEqual([
      {
        connectionType: "sse",
        sseUrl: "https://example.com/sse",
      },
    ]);
  });

  it("validates args/env/sseHeaders shapes and normalizes record keys", () => {
    const parsed = parseMCPServersConfig(
      '[{"command":"npx","args":[" -y "," server "],"env":{" KEY ":"value"}},{"connectionType":"sse","sseUrl":"https://example.com/sse","sseHeaders":{" Authorization ":" Bearer token "}}]'
    );
    expect(parsed[0]).toEqual(
      expect.objectContaining({
        args: ["-y", "server"],
        env: { KEY: "value" },
      })
    );
    expect(parsed[1]).toEqual(
      expect.objectContaining({
        sseHeaders: { Authorization: "Bearer token" },
      })
    );

    expect(() =>
      parseMCPServersConfig('[{"command":"npx","args":[1]}]')
    ).toThrow(
      'MCP server entry at index 0 must provide "args" as an array of strings.'
    );
    expect(() =>
      parseMCPServersConfig('[{"command":"npx","args":[" "]}]')
    ).toThrow(
      'MCP server entry at index 0 must provide "args" as an array of non-empty strings.'
    );
    expect(() =>
      parseMCPServersConfig('[{"command":"npx","env":{"":1}}]')
    ).toThrow(
      'MCP server entry at index 0 must provide "env" as an object of string key/value pairs.'
    );
    expect(() =>
      parseMCPServersConfig(
        '[{"connectionType":"sse","sseUrl":"https://example.com/sse","sseHeaders":{"":1}}]'
      )
    ).toThrow(
      'MCP server entry at index 0 must provide "sseHeaders" as an object of string key/value pairs.'
    );
    expect(() =>
      parseMCPServersConfig('[{"command":"npx","env":{"constructor":"oops"}}]')
    ).toThrow(
      'MCP server entry at index 0 must provide "env" as an object of string key/value pairs.'
    );
    expect(() =>
      parseMCPServersConfig('[{"command":"npx","env":{" Constructor ":"oops"}}]')
    ).toThrow(
      'MCP server entry at index 0 must provide "env" as an object of string key/value pairs.'
    );
    expect(() =>
      parseMCPServersConfig(
        '[{"connectionType":"sse","sseUrl":"https://example.com/sse","sseHeaders":{"__proto__":"oops"}}]'
      )
    ).toThrow(
      'MCP server entry at index 0 must provide "sseHeaders" as an object of string key/value pairs.'
    );
    expect(() =>
      parseMCPServersConfig(
        '[{"connectionType":"sse","sseUrl":"https://example.com/sse","sseHeaders":{"Authorization":"   "}}]'
      )
    ).toThrow(
      'MCP server entry at index 0 must provide "sseHeaders" as an object of string key/value pairs.'
    );

    expect(() =>
      parseMCPServersConfig(
        '[{"command":"npx","env":{" KEY ":"a","KEY":"b"}}]'
      )
    ).toThrow(
      'MCP server entry at index 0 has duplicate "env" key "KEY" after trimming.'
    );
    expect(() =>
      parseMCPServersConfig(
        '[{"connectionType":"sse","sseUrl":"https://example.com/sse","sseHeaders":{" Authorization ":"a","Authorization":"b"}}]'
      )
    ).toThrow(
      'MCP server entry at index 0 has duplicate "sseHeaders" key "Authorization" after trimming.'
    );
    expect(() =>
      parseMCPServersConfig(
        '[{"connectionType":"sse","sseUrl":"https://example.com/sse","sseHeaders":{"Authorization":"a","authorization":"b"}}]'
      )
    ).toThrow(
      'MCP server entry at index 0 has duplicate "sseHeaders" key "authorization" after trimming.'
    );
  });

  it("validates sseUrl formatting and protocol", () => {
    expect(() =>
      parseMCPServersConfig('[{"connectionType":"sse","sseUrl":"not-a-url"}]')
    ).toThrow(
      'MCP server entry at index 0 has invalid "sseUrl" value "not-a-url".'
    );

    expect(() =>
      parseMCPServersConfig('[{"connectionType":"sse","sseUrl":"ftp://example.com/sse"}]')
    ).toThrow(
      'MCP server entry at index 0 has unsupported sseUrl protocol "ftp:". Use http:// or https://.'
    );
  });

  it("rejects ambiguous or mixed stdio/sse field combinations", () => {
    expect(() =>
      parseMCPServersConfig(
        '[{"command":"npx","sseUrl":"https://example.com/sse"}]'
      )
    ).toThrow(
      'MCP server entry at index 0 is ambiguous: provide either "command" (stdio) or "sseUrl" (sse), or set explicit "connectionType".'
    );

    expect(() =>
      parseMCPServersConfig(
        '[{"connectionType":"sse","command":"npx","sseUrl":"https://example.com/sse"}]'
      )
    ).toThrow(
      'MCP server entry at index 0 configured as sse cannot define stdio fields ("command", "args", or "env").'
    );

    expect(() =>
      parseMCPServersConfig(
        '[{"connectionType":"stdio","command":"npx","sseUrl":"https://example.com/sse"}]'
      )
    ).toThrow(
      'MCP server entry at index 0 configured as stdio cannot define sse fields ("sseUrl" or "sseHeaders").'
    );
  });

  it("throws when includeTools and excludeTools overlap", () => {
    expect(() =>
      parseMCPServersConfig(
        '[{"command":"npx","includeTools":["search","notes"],"excludeTools":["notes"]}]'
      )
    ).toThrow(
      "MCP server entry at index 0 has tools present in both includeTools and excludeTools: notes."
    );

    expect(() =>
      parseMCPServersConfig(
        '[{"command":"npx","includeTools":["Search"],"excludeTools":["search"]}]'
      )
    ).toThrow(
      "MCP server entry at index 0 has tools present in both includeTools and excludeTools: Search."
    );
  });
});

describe("loadMCPServersFromFile", () => {
  it("loads and parses server config from file", async () => {
    const tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "hyperagent-mcp-config-")
    );
    const filePath = path.join(tempDir, "mcp.json");
    await fs.promises.writeFile(
      filePath,
      '[{"id":"demo","command":"npx","args":["-y","server"]}]',
      "utf-8"
    );

    try {
      const parsed = await loadMCPServersFromFile(filePath);
      expect(parsed).toEqual([
        {
          id: "demo",
          command: "npx",
          args: ["-y", "server"],
          connectionType: "stdio",
        },
      ]);
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws readable error when config file cannot be read", async () => {
    await expect(
      loadMCPServersFromFile("/tmp/does-not-exist-mcp-config.json")
    ).rejects.toThrow(
      'Failed to read MCP config file "/tmp/does-not-exist-mcp-config.json":'
    );
  });

  it("throws readable error when config path is not a regular file", async () => {
    const tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "hyperagent-mcp-config-")
    );

    try {
      await expect(loadMCPServersFromFile(tempDir)).rejects.toThrow(
        `Failed to read MCP config file "${tempDir}": path is not a regular file.`
      );
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws readable error when config file contents are invalid", async () => {
    const tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "hyperagent-mcp-config-")
    );
    const filePath = path.join(tempDir, "mcp.json");
    await fs.promises.writeFile(filePath, "{broken", "utf-8");

    try {
      await expect(loadMCPServersFromFile(filePath)).rejects.toThrow(
        `Invalid MCP config file "${filePath}": Invalid MCP config JSON`
      );
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws when config file exceeds maximum allowed size", async () => {
    const tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "hyperagent-mcp-config-")
    );
    const filePath = path.join(tempDir, "mcp.json");
    await fs.promises.writeFile(filePath, "x".repeat(1_000_001), "utf-8");

    try {
      await expect(loadMCPServersFromFile(filePath)).rejects.toThrow(
        `Invalid MCP config file "${filePath}": config exceeds 1000000 characters.`
      );
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });
});
