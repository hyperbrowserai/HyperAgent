import { normalizePageUrl } from "@/utils/page-url";

describe("normalizePageUrl", () => {
  it("returns fallback for non-string values", () => {
    expect(normalizePageUrl(undefined)).toBe("about:blank");
    expect(normalizePageUrl({})).toBe("about:blank");
  });

  it("sanitizes control characters and collapses whitespace", () => {
    expect(normalizePageUrl("  https://example.com/\u0000a\nb\tc  ")).toBe(
      "https://example.com/ a b c"
    );
  });

  it("returns fallback for empty normalized strings", () => {
    expect(normalizePageUrl("\u0000\n\t")).toBe("about:blank");
  });

  it("supports custom fallback values", () => {
    expect(normalizePageUrl(null, { fallback: "unknown" })).toBe("unknown");
  });

  it("truncates sanitized URLs when maxChars is provided", () => {
    const normalized = normalizePageUrl(
      `https://example.com/${"x".repeat(200)}`,
      { maxChars: 40 }
    );
    expect(normalized).toContain("[truncated");
    expect(normalized.length).toBeGreaterThan(40);
  });
});
