import { parseMCPServersConfig } from "@/cli/mcp-config";

describe("parseMCPServersConfig", () => {
  it("parses array-formatted config", () => {
    const parsed = parseMCPServersConfig(
      '[{"id":"one","command":"npx","args":["-y","server"]}]'
    );
    expect(parsed).toEqual([
      { id: "one", command: "npx", args: ["-y", "server"] },
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
});
