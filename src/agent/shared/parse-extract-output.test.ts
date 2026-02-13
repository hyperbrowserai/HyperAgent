import { z } from "zod";
import { parseExtractOutput } from "@/agent/shared/parse-extract-output";

describe("parseExtractOutput", () => {
  it("returns plain text output when no schema is provided", () => {
    expect(parseExtractOutput("hello world", "completed")).toBe("hello world");
  });

  it("throws when output is empty or non-string", () => {
    expect(() => parseExtractOutput("", "failed")).toThrow(
      "did not complete with output"
    );
    expect(() => parseExtractOutput(undefined, "failed")).toThrow(
      "did not complete with output"
    );
  });

  it("formats non-string task status diagnostics safely", () => {
    expect(() =>
      parseExtractOutput(undefined, { reason: "agent failed", code: 500 })
    ).toThrow('Task status: {"reason":"agent failed","code":500}');
  });

  it("parses and validates structured output with schema", () => {
    const schema = z.object({
      total: z.number(),
      currency: z.string(),
    });
    const parsed = parseExtractOutput(
      "{\"total\":99,\"currency\":\"USD\"}",
      "completed",
      schema
    );
    expect(parsed).toEqual({
      total: 99,
      currency: "USD",
    });
  });

  it("throws clear error for invalid JSON structured output", () => {
    const schema = z.object({
      total: z.number(),
    });
    expect(() =>
      parseExtractOutput("not-json", "completed", schema)
    ).toThrow("not valid JSON");
  });

  it("truncates oversized invalid JSON diagnostics", () => {
    const schema = z.object({
      total: z.number(),
    });
    const oversized = "x".repeat(1000);
    expect(() =>
      parseExtractOutput(oversized, "completed", schema)
    ).toThrow("[truncated]");
  });

  it("throws clear error when structured output violates schema", () => {
    const schema = z.object({
      total: z.number(),
    });
    expect(() =>
      parseExtractOutput("{\"total\":\"oops\"}", "completed", schema)
    ).toThrow("does not match schema");
  });

  it("handles primitive parsed output without crashing schema error rendering", () => {
    const schema = z.object({
      total: z.number(),
    });
    expect(() => parseExtractOutput("1", "completed", schema)).toThrow(
      "does not match schema"
    );
  });
});
