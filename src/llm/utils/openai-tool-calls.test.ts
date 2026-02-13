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
});
