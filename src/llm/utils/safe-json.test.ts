import { parseJsonMaybe } from "@/llm/utils/safe-json";

describe("parseJsonMaybe", () => {
  it("parses valid JSON strings", () => {
    expect(parseJsonMaybe('{"ok":true}')).toEqual({ ok: true });
  });

  it("parses JSON strings with BOM and surrounding whitespace", () => {
    expect(parseJsonMaybe(" \n\uFEFF {\"ok\":true} \n")).toEqual({ ok: true });
  });

  it("returns original string when parsing fails", () => {
    expect(parseJsonMaybe("{broken")).toBe("{broken");
  });

  it("returns original string when value is only whitespace", () => {
    expect(parseJsonMaybe("   ")).toBe("   ");
  });

  it("skips parsing when payload exceeds safe size threshold", () => {
    const huge = `"${"x".repeat(120000)}"`;
    expect(parseJsonMaybe(huge)).toBe(huge);
  });

  it("returns non-string values unchanged", () => {
    const obj = { a: 1 };
    expect(parseJsonMaybe(obj)).toBe(obj);
    expect(parseJsonMaybe(1)).toBe(1);
  });
});
