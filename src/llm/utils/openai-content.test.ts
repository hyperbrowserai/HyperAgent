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

    expect(result[0]?.url.length).toBeGreaterThan(4_000);
    expect(result[0]?.url).toContain("[truncated");
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

  it("normalizes single-part object payloads into content arrays", () => {
    expect(
      normalizeOpenAICompatibleContent({
        type: "text",
        text: "inline-object-part",
      })
    ).toEqual([{ type: "text", text: "inline-object-part" }]);
  });

  it("truncates oversized unknown object diagnostics", () => {
    const hugeObject = { payload: "x".repeat(5_000) };
    const result = normalizeOpenAICompatibleContent(hugeObject);
    expect(typeof result).toBe("string");
    expect(result).toContain("[truncated");
  });

  it("normalizes nullish content to empty string", () => {
    expect(normalizeOpenAICompatibleContent(null)).toBe("");
    expect(normalizeOpenAICompatibleContent(undefined)).toBe("");
  });

  it("handles content-part getters that throw", () => {
    const trappedPart = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "type") {
            throw new Error("type getter trap");
          }
          return undefined;
        },
      }
    );

    expect(
      normalizeOpenAICompatibleContent([trappedPart])
    ).toEqual([
      {
        type: "text",
        text: "{}",
      },
    ]);
  });

  it("handles tool-call field getters that throw", () => {
    const trappedFunction = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "name" || prop === "arguments") {
            throw new Error("function field trap");
          }
          return undefined;
        },
      }
    );

    expect(
      normalizeOpenAICompatibleContent([
        {
          type: "tool_call",
          function: trappedFunction,
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

  it("returns readable diagnostics when content array traversal throws", () => {
    const trappedArray = new Proxy([1], {
      get: (target, prop, receiver) => {
        if (prop === Symbol.iterator) {
          throw new Error("array iterator trap");
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    expect(
      normalizeOpenAICompatibleContent(trappedArray)
    ).toBe("array iterator trap");
  });

  it("sanitizes and truncates control-character diagnostics from traversal errors", () => {
    const trappedArray = new Proxy([1], {
      get: (target, prop, receiver) => {
        if (prop === Symbol.iterator) {
          throw new Error(`array\u0000\n${"x".repeat(5_000)}`);
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const output = normalizeOpenAICompatibleContent(trappedArray);
    expect(typeof output).toBe("string");
    expect(output).toContain("[truncated");
    expect(output).not.toContain("\u0000");
    expect(output).not.toContain("\n");
  });
});
