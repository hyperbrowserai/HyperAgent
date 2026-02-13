import { DeepSeekClient } from "@/llm/providers/deepseek";

const createCompletionMock = jest.fn();

jest.mock("openai", () => {
  return jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: createCompletionMock,
      },
    },
  }));
});

jest.mock("@/llm/utils/message-converter", () => ({
  convertToOpenAIMessages: jest.fn(() => []),
}));

describe("DeepSeekClient", () => {
  beforeEach(() => {
    createCompletionMock.mockReset();
  });

  it("converts array content blocks into HyperAgent content parts", async () => {
    createCompletionMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: [
              { type: "text", text: "alpha" },
              { type: "tool_call", function: { name: "lookup", arguments: "{broken" } },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 4,
      },
    });

    const client = new DeepSeekClient({ model: "deepseek-test" });
    const result = await client.invoke([{ role: "user", content: "hello" }]);

    expect(result.content).toEqual([
      { type: "text", text: "alpha" },
      { type: "tool_call", toolName: "lookup", arguments: "{broken" },
    ]);
  });

  it("does not crash on circular unknown array content parts", async () => {
    const circularPart: Record<string, unknown> = { type: "mystery" };
    circularPart.self = circularPart;

    createCompletionMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: [circularPart],
          },
        },
      ],
    });

    const client = new DeepSeekClient({ model: "deepseek-test" });
    const result = await client.invoke([{ role: "user", content: "hello" }]);

    expect(result.content).toEqual([
      {
        type: "text",
        text: '{"type":"mystery","self":"[Circular]"}',
      },
    ]);
  });

  it("formats object content payloads instead of returning [object Object]", async () => {
    createCompletionMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: { state: "object-content" },
          },
        },
      ],
    });

    const client = new DeepSeekClient({ model: "deepseek-test" });
    const result = await client.invoke([{ role: "user", content: "hello" }]);

    expect(result.content).toBe('{"state":"object-content"}');
  });

  it("throws readable errors for unknown tool call payloads", async () => {
    createCompletionMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: "ok",
            tool_calls: [
              {
                id: "tc-1",
                type: "mystery",
                data: { reason: "unknown type" },
              },
            ],
          },
        },
      ],
    });

    const client = new DeepSeekClient({ model: "deepseek-test" });
    await expect(
      client.invoke([{ role: "user", content: "hello" }])
    ).rejects.toThrow(
      '[LLM][DeepSeek] Unknown tool call type: {"id":"tc-1","type":"mystery","data":{"reason":"unknown type"}}'
    );
  });

  it("ignores reserved provider options overrides while preserving custom options", async () => {
    createCompletionMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: "ok",
          },
        },
      ],
    });

    const client = new DeepSeekClient({ model: "deepseek-test" });
    await client.invoke([{ role: "user", content: "hello" }], {
      providerOptions: {
        model: "override-model",
        messages: [{ role: "user", content: "bad" }],
        max_tokens: 999,
        top_p: 0.7,
      },
    });

    expect(createCompletionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "deepseek-test",
        messages: [],
        top_p: 0.7,
      })
    );
    const payload = createCompletionMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(payload?.max_tokens).not.toBe(999);
  });
});
