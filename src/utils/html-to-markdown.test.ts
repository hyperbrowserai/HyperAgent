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
});
