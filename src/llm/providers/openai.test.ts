import { OpenAIClient } from "@/llm/providers/openai";

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

describe("OpenAIClient", () => {
  beforeEach(() => {
    createCompletionMock.mockReset();
  });

  it("does not crash on unknown circular content parts", async () => {
    const circularPart: Record<string, unknown> = { type: "unknown" };
    circularPart.self = circularPart;

    createCompletionMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: [circularPart],
          },
        },
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 2,
      },
    });

    const client = new OpenAIClient({ model: "gpt-test" });
    const result = await client.invoke([{ role: "user", content: "hello" }]);

    expect(Array.isArray(result.content)).toBe(true);
    const firstPart = (result.content as Array<{ text?: string }>)[0];
    expect(firstPart?.text).toContain('"self":"[Circular]"');
  });

  it("preserves malformed tool call arguments as raw strings", async () => {
    createCompletionMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: "ok",
            tool_calls: [
              {
                id: "tc-1",
                type: "function",
                function: {
                  name: "lookup",
                  arguments: "{broken",
                },
              },
            ],
          },
        },
      ],
    });

    const client = new OpenAIClient({ model: "gpt-test" });
    const result = await client.invoke([{ role: "user", content: "hello" }]);

    expect(result.toolCalls?.[0]).toEqual({
      id: "tc-1",
      name: "lookup",
      arguments: "{broken",
    });
  });
});
