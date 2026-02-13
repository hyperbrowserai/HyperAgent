import { z } from "zod";
import { parseStructuredResponse } from "@/llm/utils/structured-response";

describe("parseStructuredResponse", () => {
  const schema = z.object({
    action: z.string(),
  });

  it("parses valid structured JSON payloads", () => {
    const result = parseStructuredResponse('{"action":"click"}', schema);
    expect(result.rawText).toBe('{"action":"click"}');
    expect(result.parsed).toEqual({ action: "click" });
  });

  it("accepts BOM-prefixed JSON payloads", () => {
    const result = parseStructuredResponse("\uFEFF{\"action\":\"click\"}", schema);
    expect(result.parsed).toEqual({ action: "click" });
  });

  it("returns null parsed output for empty payloads", () => {
    const result = parseStructuredResponse("   ", schema);
    expect(result.rawText).toBe("   ");
    expect(result.parsed).toBeNull();
  });

  it("formats non-string payloads for diagnostics without parsing", () => {
    const result = parseStructuredResponse({ ok: true }, schema);
    expect(result.rawText).toBe('{"ok":true}');
    expect(result.parsed).toBeNull();
  });

  it("returns null parsed output when schema validation fails", () => {
    const result = parseStructuredResponse('{"action":1}', schema);
    expect(result.parsed).toBeNull();
  });

  it("skips oversized payload parsing safely", () => {
    const huge = `"${"x".repeat(120_000)}"`;
    const result = parseStructuredResponse(huge, z.string());
    expect(result.rawText).toBe(huge);
    expect(result.parsed).toBeNull();
  });
});
