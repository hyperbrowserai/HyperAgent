import { OpenAIClient } from "@/llm/providers/openai";
import { z } from "zod";

const createCompletionMock = jest.fn();
const convertToOpenAIJsonSchemaMock: jest.Mock = jest.fn(() => ({
  type: "json_schema",
}));
const debugOptions = {
  enabled: false,
  structuredSchema: false,
};

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
  convertToOpenAIJsonSchema: (schema: unknown) =>
    convertToOpenAIJsonSchemaMock(schema),
}));

jest.mock("@/debug/options", () => ({
  getDebugOptions: jest.fn(() => debugOptions),
}));

const { getDebugOptions } = jest.requireMock("@/debug/options") as {
  getDebugOptions: jest.Mock;
};

describe("OpenAIClient", () => {
  beforeEach(() => {
    createCompletionMock.mockReset();
    convertToOpenAIJsonSchemaMock.mockReset();
    convertToOpenAIJsonSchemaMock.mockReturnValue({ type: "json_schema" });
    debugOptions.enabled = false;
    debugOptions.structuredSchema = false;
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

    const client = new OpenAIClient({ model: "gpt-test" });
    const result = await client.invoke([{ role: "user", content: "hello" }]);

    expect(result.content).toBe('{"state":"object-content"}');
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

    const client = new OpenAIClient({ model: "gpt-test" });
    await expect(
      client.invoke([{ role: "user", content: "hello" }])
    ).rejects.toThrow(
      '[LLM][OpenAI] Unknown tool call type: {"id":"tc-1","type":"mystery","data":{"reason":"unknown type"}}'
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

    const client = new OpenAIClient({ model: "gpt-test" });
    await client.invoke([{ role: "user", content: "hello" }], {
      providerOptions: {
        model: "override-model",
        " Model ": "override-again",
        messages: [{ role: "user", content: "bad" }],
        max_tokens: 999,
        top_p: 0.7,
      },
    });

    expect(createCompletionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-test",
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
            content: '{"ok":"yes"}',
          },
        },
      ],
    });

    const client = new OpenAIClient({ model: "gpt-test" });
    await client.invokeStructured(
      {
        schema: z.object({ ok: z.string() }),
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
        model: "gpt-test",
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

    const client = new OpenAIClient({ model: "gpt-test" });
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

  it("does not crash structured-schema debug logging on circular schema payloads", async () => {
    const circularSchema: Record<string, unknown> = {};
    circularSchema.self = circularSchema;
    convertToOpenAIJsonSchemaMock.mockReturnValue({
      json_schema: {
        schema: circularSchema,
      },
    });

    createCompletionMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: '{"ok":"yes"}',
          },
        },
      ],
    });

    debugOptions.enabled = true;
    debugOptions.structuredSchema = true;
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      const client = new OpenAIClient({ model: "gpt-test" });
      const result = await client.invokeStructured(
        {
          schema: z.object({
            ok: z.string(),
          }),
        },
        [{ role: "user", content: "hello" }]
      );

      expect(result.parsed).toEqual({ ok: "yes" });
      expect(logSpy).toHaveBeenCalledWith(
        "[LLM][OpenAI] Structured output schema:",
        expect.stringContaining('"self":"[Circular]"')
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("continues structured invocation when debug option getter traps", async () => {
    createCompletionMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: '{"ok":"yes"}',
          },
        },
      ],
    });
    getDebugOptions.mockImplementationOnce(() => {
      throw new Error("debug options trap");
    });

    const client = new OpenAIClient({ model: "gpt-test" });
    const result = await client.invokeStructured(
      {
        schema: z.object({
          ok: z.string(),
        }),
      },
      [{ role: "user", content: "hello" }]
    );

    expect(result.parsed).toEqual({ ok: "yes" });
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

    const client = new OpenAIClient({ model: "gpt-test" });
    await expect(
      client.invoke([{ role: "user", content: "hello" }])
    ).rejects.toThrow(
      "[LLM][OpenAI] Invalid completion payload: failed to read choices (choices getter trap)"
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

    const client = new OpenAIClient({ model: "gpt-test" });
    await expect(
      client.invoke([{ role: "user", content: "hello" }])
    ).rejects.toThrow(
      "[LLM][OpenAI] Invalid completion payload: failed to read choice.message (message getter trap)"
    );
  });

  it("sanitizes and truncates oversized completion diagnostics", async () => {
    const response = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "choices") {
            throw new Error(`choices\u0000\n${"x".repeat(2_000)}`);
          }
          return undefined;
        },
      }
    );
    createCompletionMock.mockResolvedValue(response);

    const client = new OpenAIClient({ model: "gpt-test" });
    await client
      .invoke([{ role: "user", content: "hello" }])
      .then(() => {
        throw new Error("expected invoke to reject");
      })
      .catch((error) => {
        const message = String(error instanceof Error ? error.message : error);
        expect(message).toContain("[truncated");
        expect(message).not.toContain("\u0000");
        expect(message).not.toContain("\n");
        expect(message.length).toBeLessThan(700);
      });
  });
});
