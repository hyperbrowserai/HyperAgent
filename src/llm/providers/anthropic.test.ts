import { z } from "zod";
import { AnthropicClient } from "@/llm/providers/anthropic";

const createMessageMock = jest.fn();
const convertToAnthropicToolMock: jest.Mock = jest.fn(() => ({
  name: "structured_output",
  input_schema: { type: "object", properties: {} },
}));
const debugOptions = {
  enabled: false,
  structuredSchema: false,
};

jest.mock("@anthropic-ai/sdk", () => {
  return jest.fn().mockImplementation(() => ({
    messages: {
      create: createMessageMock,
    },
  }));
});

jest.mock("@/llm/utils/message-converter", () => ({
  convertToAnthropicMessages: jest.fn(() => ({
    messages: [],
    system: "system",
  })),
}));

jest.mock("@/llm/utils/schema-converter", () => ({
  convertActionsToAnthropicTools: jest.fn((actions: Array<{ type: string }>) =>
    actions.map((action) => ({ name: action.type }))
  ),
  convertToAnthropicTool: (schema: unknown) =>
    convertToAnthropicToolMock(schema),
  createAnthropicToolChoice: jest.fn(() => ({ type: "tool" })),
}));

jest.mock("@/debug/options", () => ({
  getDebugOptions: jest.fn(() => debugOptions),
}));

describe("AnthropicClient", () => {
  beforeEach(() => {
    createMessageMock.mockReset();
    convertToAnthropicToolMock.mockReset();
    convertToAnthropicToolMock.mockReturnValue({
      name: "structured_output",
      input_schema: { type: "object", properties: {} },
    });
    debugOptions.enabled = false;
    debugOptions.structuredSchema = false;
  });

  it("returns first text block even when not first content part", async () => {
    createMessageMock.mockResolvedValue({
      content: [
        { type: "tool_use", name: "ignore", input: {} },
        { type: "text", text: "hello from anthropic" },
      ],
      usage: {
        input_tokens: 5,
        output_tokens: 7,
      },
    });

    const client = new AnthropicClient({ model: "claude-test" });
    const result = await client.invoke([
      { role: "user", content: "Hi" },
    ]);

    expect(result.content).toBe("hello from anthropic");
    expect(result.usage).toEqual({
      inputTokens: 5,
      outputTokens: 7,
    });
  });

  it("concatenates multiple text blocks in invoke responses", async () => {
    createMessageMock.mockResolvedValue({
      content: [
        { type: "text", text: "first" },
        { type: "tool_use", name: "ignored", input: {} },
        { type: "text", text: "second" },
      ],
      usage: {
        input_tokens: 3,
        output_tokens: 4,
      },
    });

    const client = new AnthropicClient({ model: "claude-test" });
    const result = await client.invoke([{ role: "user", content: "Hi" }]);

    expect(result.content).toBe("first\n\nsecond");
  });

  it("parses simple-tool structured output when tool_use block is not first", async () => {
    createMessageMock.mockResolvedValue({
      content: [
        { type: "text", text: "draft" },
        {
          type: "tool_use",
          input: {
            result: {
              value: "ok",
            },
          },
        },
      ],
    });

    const client = new AnthropicClient({ model: "claude-test" });
    const result = await client.invokeStructured(
      {
        schema: z.object({
          value: z.string(),
        }),
      },
      [{ role: "user", content: "extract value" }]
    );

    expect(result.parsed).toEqual({ value: "ok" });
    expect(result.rawText).toContain('"result"');
  });

  it("returns null parsed output for non-object simple-tool payloads", async () => {
    createMessageMock.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          input: "malformed",
        },
      ],
    });

    const client = new AnthropicClient({ model: "claude-test" });
    const result = await client.invokeStructured(
      {
        schema: z.object({
          value: z.string(),
        }),
      },
      [{ role: "user", content: "extract value" }]
    );

    expect(result.parsed).toBeNull();
    expect(result.rawText).toBe("malformed");
  });

  it("formats non-Error param validation failures in tool path warnings", async () => {
    createMessageMock.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "click",
          input: {
            action: {
              params: {},
            },
          },
        },
      ],
    });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const client = new AnthropicClient({ model: "claude-test" });
    await client.invokeStructured(
      {
        schema: z.object({
          thoughts: z.string().optional(),
          memory: z.string().optional(),
          action: z.object({
            type: z.string(),
            params: z.record(z.string(), z.unknown()),
          }),
        }),
        actions: [
          {
            type: "click",
            actionParams: {
              parse: () => {
                throw { reason: "param parse failed" };
              },
            } as unknown as z.ZodTypeAny,
            run: async () => ({ success: true, message: "ok" }),
          },
        ],
      },
      [{ role: "user", content: "click it" }]
    );

    expect(warnSpy).toHaveBeenCalledWith(
      '[LLM][Anthropic] Failed to validate params for action click: {"reason":"param parse failed"}'
    );
    warnSpy.mockRestore();
  });

  it("does not crash simple-tool debug logging on circular tool payloads", async () => {
    const circularTool: Record<string, unknown> = { name: "structured_output" };
    circularTool.self = circularTool;
    convertToAnthropicToolMock.mockReturnValue(circularTool);
    createMessageMock.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          input: {
            result: {
              value: "ok",
            },
          },
        },
      ],
    });
    debugOptions.enabled = true;
    debugOptions.structuredSchema = true;
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      const client = new AnthropicClient({ model: "claude-test" });
      const result = await client.invokeStructured(
        {
          schema: z.object({
            value: z.string(),
          }),
        },
        [{ role: "user", content: "extract value" }]
      );

      expect(result.parsed).toEqual({ value: "ok" });
      expect(logSpy).toHaveBeenCalledWith(
        "[LLM][Anthropic] Simple structured output tool:",
        expect.stringContaining('"self":"[Circular]"')
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("ignores reserved provider option overrides while preserving custom options", async () => {
    createMessageMock.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 1,
        output_tokens: 2,
      },
    });

    const client = new AnthropicClient({ model: "claude-test" });
    await client.invoke([{ role: "user", content: "hello" }], {
      providerOptions: {
        model: "override-model",
        messages: [{ role: "user", content: "bad" }],
        max_tokens: 999,
        top_p: 0.7,
      },
    });

    expect(createMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-test",
        messages: [],
        top_p: 0.7,
      })
    );
    const payload = createMessageMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(payload?.max_tokens).not.toBe(999);
  });

  it("sanitizes reserved provider options in simple structured path", async () => {
    createMessageMock.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          input: {
            result: {
              value: "ok",
            },
          },
        },
      ],
    });

    const client = new AnthropicClient({ model: "claude-test" });
    await client.invokeStructured(
      {
        schema: z.object({
          value: z.string(),
        }),
        options: {
          providerOptions: {
            model: "override-model",
            messages: [{ role: "user", content: "bad" }],
            tools: [{ name: "override-tool" }],
            tool_choice: { type: "any" },
            top_p: 0.7,
          },
        },
      },
      [{ role: "user", content: "hello" }]
    );

    expect(createMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-test",
        messages: [],
        top_p: 0.7,
      })
    );
    const payload = createMessageMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(payload?.tools).toEqual([
      {
        name: "structured_output",
        input_schema: { type: "object", properties: {} },
      },
    ]);
    expect(payload?.tool_choice).toEqual({ type: "tool" });
  });

  it("sanitizes nested unsafe keys and circular provider options", async () => {
    createMessageMock.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 1,
        output_tokens: 2,
      },
    });

    const circular: Record<string, unknown> = { id: "node" };
    circular.self = circular;

    const client = new AnthropicClient({ model: "claude-test" });
    await client.invoke([{ role: "user", content: "hello" }], {
      providerOptions: {
        metadata: {
          safe: "yes",
          constructor: "bad",
          nested: circular,
        },
      },
    });

    expect(createMessageMock).toHaveBeenCalledWith(
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

  it("throws readable error when response content field is unreadable", async () => {
    const response = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "content") {
            throw new Error("content getter trap");
          }
          return undefined;
        },
      }
    );
    createMessageMock.mockResolvedValue(response);

    const client = new AnthropicClient({ model: "claude-test" });
    await expect(
      client.invoke([{ role: "user", content: "hello" }])
    ).rejects.toThrow(
      "[LLM][Anthropic] Invalid response payload: failed to read content (content getter trap)"
    );
  });

  it("throws readable error when response content is not an array", async () => {
    createMessageMock.mockResolvedValue({
      content: { bad: true },
    });

    const client = new AnthropicClient({ model: "claude-test" });
    await expect(
      client.invoke([{ role: "user", content: "hello" }])
    ).rejects.toThrow(
      "[LLM][Anthropic] Invalid response payload: content must be an array"
    );
  });
});
