import { normalizeOpenAIToolCalls } from "@/llm/utils/openai-tool-calls";

describe("normalizeOpenAIToolCalls", () => {
  it("returns undefined when tool_calls is not an array", () => {
    expect(normalizeOpenAIToolCalls(undefined)).toBeUndefined();
    expect(normalizeOpenAIToolCalls("oops")).toBeUndefined();
  });

  it("normalizes function and custom tool calls", () => {
    const result = normalizeOpenAIToolCalls([
      {
        id: "fn-1",
        type: "function",
        function: {
          name: "search",
          arguments: '{"q":"hello"}',
        },
      },
      {
        id: "custom-1",
        type: "custom",
        custom: {
          name: "lookup",
          input: "{broken",
        },
      },
    ]);

    expect(result).toEqual([
      {
        id: "fn-1",
        name: "search",
        arguments: { q: "hello" },
      },
      {
        id: "custom-1",
        name: "lookup",
        arguments: "{broken",
      },
    ]);
  });

  it("formats unknown tool call type errors with serialized payloads", () => {
    expect(() =>
      normalizeOpenAIToolCalls([
        {
          id: "x",
          type: "mystery",
          data: { answer: 42 },
        },
      ])
    ).toThrow(
      '[LLM][OpenAI] Unknown tool call type: {"id":"x","type":"mystery","data":{"answer":42}}'
    );
  });

  it("formats non-object tool call entries with readable errors", () => {
    expect(() => normalizeOpenAIToolCalls([null])).toThrow(
      "[LLM][OpenAI] Unknown tool call payload: null"
    );
  });

  it("supports provider-specific labels in error messages", () => {
    expect(() =>
      normalizeOpenAIToolCalls(
        [
          {
            id: "x",
            type: "mystery",
          },
        ],
        "DeepSeek"
      )
    ).toThrow('[LLM][DeepSeek] Unknown tool call type: {"id":"x","type":"mystery"}');
  });

  it("normalizes provider labels used in diagnostics", () => {
    expect(() =>
      normalizeOpenAIToolCalls(
        [
          {
            id: "x",
            type: "mystery",
          },
        ],
        "  DeepSeek\u0000 Provider \n Name That Is Really Really Long  "
      )
    ).toThrow("[LLM][DeepSeek Provider Name That Is Really Re]");
  });

  it("truncates oversized tool-call diagnostics in errors", () => {
    const huge = "x".repeat(3_500);
    expect(() =>
      normalizeOpenAIToolCalls([
        {
          type: "mystery",
          payload: huge,
        },
      ])
    ).toThrow("[truncated");
  });

  it("normalizes whitespace-only ids and tool names safely", () => {
    expect(
      normalizeOpenAIToolCalls([
        {
          id: "   ",
          type: "function",
          function: {
            name: "   ",
            arguments: "{}",
          },
        },
      ])
    ).toEqual([
      {
        id: undefined,
        name: "unknown-tool",
        arguments: {},
      },
    ]);
  });

  it("sanitizes unsafe keys from parsed tool-call arguments", () => {
    expect(
      normalizeOpenAIToolCalls([
        {
          id: "fn-1",
          type: "function",
          function: {
            name: "lookup",
            arguments:
              '{"safe":1,"__proto__":{"polluted":true},"nested":{"constructor":"bad","ok":true}}',
          },
        },
      ])
    ).toEqual([
      {
        id: "fn-1",
        name: "lookup",
        arguments: {
          safe: 1,
          nested: {
            ok: true,
          },
        },
      },
    ]);
  });

  it("sanitizes circular direct-object arguments safely", () => {
    const circular: Record<string, unknown> = { id: "node" };
    circular.self = circular;

    expect(
      normalizeOpenAIToolCalls([
        {
          id: "custom-1",
          type: "custom",
          custom: {
            name: "lookup",
            input: circular,
          },
        },
      ])
    ).toEqual([
      {
        id: "custom-1",
        name: "lookup",
        arguments: {
          id: "node",
          self: "[Circular]",
        },
      },
    ]);
  });

  it("defaults missing tool-call arguments to empty object", () => {
    expect(
      normalizeOpenAIToolCalls([
        {
          id: "fn-1",
          type: "function",
          function: {
            name: "lookup",
          },
        },
      ])
    ).toEqual([
      {
        id: "fn-1",
        name: "lookup",
        arguments: {},
      },
    ]);
  });

  it("collapses whitespace in normalized tool-call names", () => {
    expect(
      normalizeOpenAIToolCalls([
        {
          id: "fn-1",
          type: "function",
          function: {
            name: "  lookup\n\tuser  ",
            arguments: "{}",
          },
        },
      ])
    ).toEqual([
      {
        id: "fn-1",
        name: "lookup user",
        arguments: {},
      },
    ]);
  });

  it("strips control characters and truncates oversized identifiers", () => {
    const hugeName = `\u0000tool ${"x".repeat(400)}\n`;
    const hugeId = `\u0000id ${"y".repeat(400)}\n`;

    const result = normalizeOpenAIToolCalls([
      {
        id: hugeId,
        type: "function",
        function: {
          name: hugeName,
          arguments: "{}",
        },
      },
    ]);

    const normalized = result?.[0];
    expect(normalized?.id?.length).toBeLessThanOrEqual(256);
    expect(normalized?.name.length ?? 0).toBeLessThanOrEqual(256);
    expect(normalized?.id).not.toContain("\u0000");
    expect(normalized?.name).not.toContain("\u0000");
  });

  it("handles function tool fields with throwing getters", () => {
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
      normalizeOpenAIToolCalls([
        {
          id: "fn-1",
          type: "function",
          function: trappedFunction,
        },
      ])
    ).toEqual([
      {
        id: "fn-1",
        name: "unknown-tool",
        arguments: {},
      },
    ]);
  });

  it("handles tool-call type getters that throw", () => {
    const trappedToolCall = new Proxy(
      {
        id: "fn-1",
      },
      {
        get: (target, prop, receiver) => {
          if (prop === "type") {
            throw new Error("type trap");
          }
          return Reflect.get(target, prop, receiver);
        },
      }
    );

    expect(() => normalizeOpenAIToolCalls([trappedToolCall])).toThrow(
      '[LLM][OpenAI] Unknown tool call type: {"id":"fn-1"}'
    );
  });

  it("throws readable error when tool-call array traversal fails", () => {
    const trappedArray = new Proxy([{}], {
      get: (target, prop, receiver) => {
        if (prop === Symbol.iterator) {
          throw new Error("tool-call iterator trap");
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    expect(() =>
      normalizeOpenAIToolCalls(trappedArray)
    ).toThrow(
      "[LLM][OpenAI] Unknown tool calls payload: tool-call iterator trap"
    );
  });

  it("sanitizes and truncates oversized traversal diagnostics", () => {
    const trappedArray = new Proxy([{}], {
      get: (target, prop, receiver) => {
        if (prop === Symbol.iterator) {
          throw new Error(`iterator\u0000\n${"x".repeat(5_000)}`);
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    try {
      normalizeOpenAIToolCalls(trappedArray);
      throw new Error("Expected normalizeOpenAIToolCalls to throw");
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      expect(message).toContain("[truncated");
      expect(message).not.toContain("\u0000");
      expect(message).not.toContain("\n");
      expect(message.length).toBeLessThan(2_500);
    }
  });

  it("normalizes non-string provider labels safely", () => {
    expect(() =>
      normalizeOpenAIToolCalls(
        [
          {
            type: "mystery",
          },
        ],
        { provider: "mystery" } as unknown as string
      )
    ).toThrow('[LLM][{"provider":"mystery"}] Unknown tool call type: {"type":"mystery"}');
  });
});
