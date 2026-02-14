import { parseMarkdown, turndownService } from "@/utils/html-to-markdown";

describe("parseMarkdown", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns empty string for nullish HTML", async () => {
    await expect(parseMarkdown(null)).resolves.toBe("");
    await expect(parseMarkdown(undefined)).resolves.toBe("");
  });

  it("formats non-Error turndown failures and returns empty markdown", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(turndownService, "turndown").mockImplementation(() => {
      throw { reason: "turndown crashed" };
    });

    try {
      const result = await parseMarkdown("<div>content</div>");

      expect(result).toBe("");
      expect(errorSpy).toHaveBeenCalledWith(
        'Error converting HTML to Markdown: {"reason":"turndown crashed"}'
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("sanitizes and truncates oversized turndown diagnostics", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(turndownService, "turndown").mockImplementation(() => {
      throw new Error(`markdown\u0000\n${"x".repeat(10_000)}`);
    });

    try {
      const result = await parseMarkdown("<div>content</div>");

      expect(result).toBe("");
      const diagnostic = String(errorSpy.mock.calls[0]?.[0] ?? "");
      expect(diagnostic).toContain("[truncated");
      expect(diagnostic).not.toContain("\u0000");
      expect(diagnostic).not.toContain("\n");
      expect(diagnostic.length).toBeLessThan(700);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
