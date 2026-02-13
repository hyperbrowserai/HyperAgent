import { normalizeMCPToolParams } from "@/agent/mcp/client";

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
