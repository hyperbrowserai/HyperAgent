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

  it("sanitizes custom fallback values", () => {
    expect(normalizePageUrl(null, { fallback: " bad\u0000\nfallback " })).toBe(
      "bad fallback"
    );
  });

  it("truncates sanitized URLs when maxChars is provided", () => {
    const normalized = normalizePageUrl(
      `https://example.com/${"x".repeat(200)}`,
      { maxChars: 40 }
    );
    expect(normalized).toContain("[truncated");
    expect(normalized.length).toBeGreaterThan(40);
  });

  it("does not throw when options getters trap", () => {
    const trappedOptions = new Proxy(
      {},
      {
        get: (_target, prop: string | symbol) => {
          if (prop === "fallback" || prop === "maxChars") {
            throw new Error("option trap");
          }
          return undefined;
        },
      }
    );

    expect(() =>
      normalizePageUrl(
        "https://example.com/path",
        trappedOptions as unknown as Parameters<typeof normalizePageUrl>[1]
      )
    ).not.toThrow();
    expect(
      normalizePageUrl(
        "https://example.com/path",
        trappedOptions as unknown as Parameters<typeof normalizePageUrl>[1]
      )
    ).toBe("https://example.com/path");
    expect(
      normalizePageUrl(
        undefined,
        trappedOptions as unknown as Parameters<typeof normalizePageUrl>[1]
      )
    ).toBe("about:blank");
  });
});
