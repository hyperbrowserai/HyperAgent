import { DeepSeekClient } from "@/llm/providers/deepseek";
import { z } from "zod";

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

jest.mock("@/llm/utils/schema-converter", () => ({
  convertToOpenAIJsonSchema: jest.fn(() => ({ type: "json_schema" })),
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

  it("sanitizes reserved provider options in structured invoke path", async () => {
    createCompletionMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: '{"ok":true}',
          },
        },
      ],
    });

    const client = new DeepSeekClient({ model: "deepseek-test" });
    await client.invokeStructured(
      {
        schema: z.object({ ok: z.boolean() }),
        options: {
          providerOptions: {
            model: "override-model",
            messages: [{ role: "user", content: "bad" }],
            response_format: { type: "text" },
            top_p: 0.4,
          },
        },
      },
      [{ role: "user", content: "hello" }]
    );

    expect(createCompletionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "deepseek-test",
        messages: [],
        response_format: { type: "json_schema" },
        top_p: 0.4,
      })
    );
  });

  it("sanitizes nested unsafe keys and circular provider options", async () => {
    createCompletionMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: "ok",
          },
        },
      ],
    });

    const circular: Record<string, unknown> = { id: "node" };
    circular.self = circular;

    const client = new DeepSeekClient({ model: "deepseek-test" });
    await client.invoke([{ role: "user", content: "hello" }], {
      providerOptions: {
        metadata: {
          safe: "yes",
          constructor: "bad",
          nested: circular,
        },
      },
    });

    expect(createCompletionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          safe: "yes",
          nested: {
            id: "node",
            self: "[Circular]",
          },
        },
      })
    );
  });

  it("throws readable error when completion choices are unreadable", async () => {
    const response = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "choices") {
            throw new Error("choices getter trap");
          }
          return undefined;
        },
      }
    );
    createCompletionMock.mockResolvedValue(response);

    const client = new DeepSeekClient({ model: "deepseek-test" });
    await expect(
      client.invoke([{ role: "user", content: "hello" }])
    ).rejects.toThrow(
      "[LLM][DeepSeek] Invalid completion payload: failed to read choices (choices getter trap)"
    );
  });

  it("throws readable error when completion message fields are unreadable", async () => {
    const choice = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "message") {
            throw new Error("message getter trap");
          }
          return undefined;
        },
      }
    );
    createCompletionMock.mockResolvedValue({
      choices: [choice],
    });

    const client = new DeepSeekClient({ model: "deepseek-test" });
    await expect(
      client.invoke([{ role: "user", content: "hello" }])
    ).rejects.toThrow(
      "[LLM][DeepSeek] Invalid completion payload: failed to read choice.message (message getter trap)"
    );
  });
});
