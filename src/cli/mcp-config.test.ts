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

  it("throws clear message for invalid JSON", () => {
    expect(() => parseMCPServersConfig("{broken")).toThrow(
      "Invalid MCP config JSON"
    );
  });

  it("throws when payload is not servers-shaped", () => {
    expect(() => parseMCPServersConfig('{"foo":1}')).toThrow(
      'MCP config must be a JSON array or an object with a "servers" array.'
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

  it("returns normalized trimmed id/command/sseUrl fields", () => {
    const parsed = parseMCPServersConfig(
      '[{"id":"  stdio-1  ","command":"  npx  "},{"connectionType":"sse","id":"  ","sseUrl":"  https://example.com/sse  "}]'
    );

    expect(parsed).toEqual([
      {
        id: "stdio-1",
        command: "npx",
        connectionType: "stdio",
      },
      {
        connectionType: "sse",
        sseUrl: "https://example.com/sse",
      },
    ]);
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
});
