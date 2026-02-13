import { normalizeOpenAICompatibleContent } from "@/llm/utils/openai-content";

describe("normalizeOpenAICompatibleContent", () => {
  it("returns strings unchanged", () => {
    expect(normalizeOpenAICompatibleContent("hello")).toBe("hello");
  });

  it("normalizes content-part arrays", () => {
    expect(
      normalizeOpenAICompatibleContent([
        { type: "text", text: "a" },
        { type: "image_url", image_url: { url: "https://example.com/img.png" } },
        { type: "tool_call", function: { name: "lookup", arguments: '{"id":1}' } },
      ])
    ).toEqual([
      { type: "text", text: "a" },
      { type: "image", url: "https://example.com/img.png", mimeType: "image/png" },
      { type: "tool_call", toolName: "lookup", arguments: { id: 1 } },
    ]);
  });

  it("formats non-string text-part payloads safely", () => {
    expect(
      normalizeOpenAICompatibleContent([
        { type: "text", text: 123 },
        { type: "text", text: null },
      ])
    ).toEqual([
      { type: "text", text: "123" },
      { type: "text", text: "null" },
    ]);
  });

  it("formats unknown object payloads safely", () => {
    const circular: Record<string, unknown> = { kind: "mystery" };
    circular.self = circular;

    expect(normalizeOpenAICompatibleContent(circular)).toBe(
      '{"kind":"mystery","self":"[Circular]"}'
    );
  });

  it("normalizes nullish content to empty string", () => {
    expect(normalizeOpenAICompatibleContent(null)).toBe("");
    expect(normalizeOpenAICompatibleContent(undefined)).toBe("");
  });
});
