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
});
