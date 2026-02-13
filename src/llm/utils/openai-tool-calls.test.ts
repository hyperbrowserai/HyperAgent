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
});
