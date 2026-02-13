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

  it("formats non-string image URLs safely for diagnostics", () => {
    expect(
      normalizeOpenAICompatibleContent([
        {
          type: "image_url",
          image_url: { url: { href: "bad-shape" } },
        },
      ])
    ).toEqual([
      {
        type: "image",
        url: '{"href":"bad-shape"}',
        mimeType: "image/png",
      },
    ]);
  });

  it("normalizes and trims string image URLs", () => {
    expect(
      normalizeOpenAICompatibleContent([
        {
          type: "image_url",
          image_url: { url: "  https://example.com/path\n  " },
        },
      ])
    ).toEqual([
      {
        type: "image",
        url: "https://example.com/path",
        mimeType: "image/png",
      },
    ]);
  });

  it("truncates oversized image URL diagnostics", () => {
    const huge = { url: "x".repeat(10_000) };
    const result = normalizeOpenAICompatibleContent([
      {
        type: "image_url",
        image_url: { url: huge },
      },
    ]) as Array<{ url: string }>;

    expect(result[0]?.url.length).toBeLessThanOrEqual(4_000);
  });

  it("sanitizes unsafe keys in tool-call content arguments", () => {
    expect(
      normalizeOpenAICompatibleContent([
        {
          type: "tool_call",
          function: {
            name: "lookup",
            arguments:
              '{"safe":1,"__proto__":{"polluted":true},"nested":{"constructor":"bad","ok":true}}',
          },
        },
      ])
    ).toEqual([
      {
        type: "tool_call",
        toolName: "lookup",
        arguments: {
          safe: 1,
          nested: {
            ok: true,
          },
        },
      },
    ]);
  });

  it("defaults missing tool-call content arguments to empty object", () => {
    expect(
      normalizeOpenAICompatibleContent([
        {
          type: "tool_call",
          function: {
            name: "lookup",
          },
        },
      ])
    ).toEqual([
      {
        type: "tool_call",
        toolName: "lookup",
        arguments: {},
      },
    ]);
  });

  it("normalizes whitespace-only tool names to fallback", () => {
    expect(
      normalizeOpenAICompatibleContent([
        {
          type: "tool_call",
          function: {
            name: "   ",
            arguments: "{}",
          },
        },
      ])
    ).toEqual([
      {
        type: "tool_call",
        toolName: "unknown-tool",
        arguments: {},
      },
    ]);
  });

  it("collapses whitespace in normalized tool_call names", () => {
    expect(
      normalizeOpenAICompatibleContent([
        {
          type: "tool_call",
          function: {
            name: "  lookup\n\tuser  ",
            arguments: "{}",
          },
        },
      ])
    ).toEqual([
      {
        type: "tool_call",
        toolName: "lookup user",
        arguments: {},
      },
    ]);
  });

  it("strips control characters and truncates oversized tool names", () => {
    const hugeName = `\u0000tool ${"x".repeat(400)}\n`;
    const result = normalizeOpenAICompatibleContent([
      {
        type: "tool_call",
        function: {
          name: hugeName,
          arguments: "{}",
        },
      },
    ]);

    const toolPart = result as Array<{ toolName: string }>;
    expect(toolPart[0]?.toolName.length).toBeLessThanOrEqual(256);
    expect(toolPart[0]?.toolName).not.toContain("\u0000");
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
