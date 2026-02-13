import { z } from "zod";
import { GeminiClient } from "@/llm/providers/gemini";

const generateContentMock = jest.fn();
const convertToGeminiMessagesMock: jest.Mock = jest.fn(() => ({
  messages: [{ role: "user", parts: [{ text: "hello" }] }],
  systemInstruction: "follow system rules",
}));
const convertToGeminiResponseSchemaMock: jest.Mock = jest.fn(() => ({
  type: "object",
  properties: { ok: { type: "boolean" } },
}));

jest.mock("@google/genai", () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: {
      generateContent: generateContentMock,
    },
  })),
}));

jest.mock("@/llm/utils/message-converter", () => ({
  convertToGeminiMessages: (messages: unknown) =>
    convertToGeminiMessagesMock(messages),
}));

jest.mock("@/llm/utils/schema-converter", () => ({
  convertToGeminiResponseSchema: (schema: unknown) =>
    convertToGeminiResponseSchemaMock(schema),
}));

describe("GeminiClient", () => {
  beforeEach(() => {
    generateContentMock.mockReset();
    convertToGeminiMessagesMock.mockReset();
    convertToGeminiMessagesMock.mockReturnValue({
      messages: [{ role: "user", parts: [{ text: "hello" }] }],
      systemInstruction: "follow system rules",
    });
    convertToGeminiResponseSchemaMock.mockReset();
    convertToGeminiResponseSchemaMock.mockReturnValue({
      type: "object",
      properties: { ok: { type: "boolean" } },
    });
  });

  it("passes options and system instruction for invoke requests", async () => {
    generateContentMock.mockResolvedValue({
      text: "result text",
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
      },
    });

    const client = new GeminiClient({
      model: "gemini-test",
      temperature: 0.1,
      maxTokens: 50,
    });
    const result = await client.invoke(
      [{ role: "user", content: "hello" }],
      {
        temperature: 0.7,
        maxTokens: 120,
        providerOptions: { topK: 3 },
      }
    );

    expect(result.content).toBe("result text");
    expect(generateContentMock).toHaveBeenCalledWith({
      model: "gemini-test",
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      config: {
        topK: 3,
        temperature: 0.7,
        maxOutputTokens: 120,
        systemInstruction: "follow system rules",
      },
    });
  });

  it("passes structured config while preserving schema constraints", async () => {
    generateContentMock.mockResolvedValue({
      text: '{"ok":true}',
    });

    const client = new GeminiClient({
      model: "gemini-test",
      temperature: 0.1,
      maxTokens: 50,
    });
    const result = await client.invokeStructured(
      {
        schema: z.object({
          ok: z.boolean(),
        }),
        options: {
          providerOptions: { topP: 0.9 },
        },
      },
      [{ role: "user", content: "hello" }]
    );

    expect(result.parsed).toEqual({ ok: true });
    expect(generateContentMock).toHaveBeenCalledWith({
      model: "gemini-test",
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      config: {
        topP: 0.9,
        temperature: 0.1,
        maxOutputTokens: 50,
        systemInstruction: "follow system rules",
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
      },
    });
  });

  it("throws clear error when invoke response text is missing", async () => {
    generateContentMock.mockResolvedValue({
      text: "",
    });

    const client = new GeminiClient({
      model: "gemini-test",
    });

    await expect(
      client.invoke([{ role: "user", content: "hello" }])
    ).rejects.toThrow("No text response from Gemini");
  });

  it("throws readable error when invoke response text is not a string", async () => {
    generateContentMock.mockResolvedValue({
      text: { value: "bad-shape" },
    });

    const client = new GeminiClient({
      model: "gemini-test",
    });

    await expect(
      client.invoke([{ role: "user", content: "hello" }])
    ).rejects.toThrow(
      '[LLM][Gemini] Invalid response payload: expected text string, received {"value":"bad-shape"}'
    );
  });

  it("returns null structured output when response text getter throws", async () => {
    const response = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "text") {
            throw new Error("text getter trap");
          }
          return undefined;
        },
      }
    );
    generateContentMock.mockResolvedValue(response);

    const client = new GeminiClient({
      model: "gemini-test",
    });

    const result = await client.invokeStructured(
      {
        schema: z.object({ ok: z.boolean() }),
      },
      [{ role: "user", content: "hello" }]
    );
    expect(result.parsed).toBeNull();
    expect(result.rawText).toContain("text getter trap");
  });

  it("sanitizes reserved config keys from provider options", async () => {
    generateContentMock.mockResolvedValue({
      text: "result text",
    });

    const client = new GeminiClient({
      model: "gemini-test",
      temperature: 0.1,
      maxTokens: 50,
    });
    await client.invoke(
      [{ role: "user", content: "hello" }],
      {
        temperature: 0.7,
        maxTokens: 120,
        providerOptions: {
          temperature: 999,
          maxOutputTokens: 999,
          systemInstruction: "override",
          topK: 9,
        },
      }
    );

    expect(generateContentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          temperature: 0.7,
          maxOutputTokens: 120,
          systemInstruction: "follow system rules",
          topK: 9,
        }),
      })
    );
  });

  it("ignores non-object provider options safely", async () => {
    generateContentMock.mockResolvedValue({
      text: "result text",
    });

    const client = new GeminiClient({
      model: "gemini-test",
      temperature: 0.1,
      maxTokens: 50,
    });
    await client.invoke(
      [{ role: "user", content: "hello" }],
      {
        providerOptions: "oops" as unknown as Record<string, unknown>,
      }
    );

    expect(generateContentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          temperature: 0.1,
          maxOutputTokens: 50,
          systemInstruction: "follow system rules",
        },
      })
    );
  });

  it("sanitizes nested unsafe keys and circular provider options", async () => {
    generateContentMock.mockResolvedValue({
      text: "result text",
    });

    const circular: Record<string, unknown> = { id: "node" };
    circular.self = circular;

    const client = new GeminiClient({
      model: "gemini-test",
      temperature: 0.1,
      maxTokens: 50,
    });
    await client.invoke(
      [{ role: "user", content: "hello" }],
      {
        providerOptions: {
          metadata: {
            safe: "yes",
            constructor: "bad",
            nested: circular,
          },
        },
      }
    );

    expect(generateContentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          metadata: {
            safe: "yes",
            nested: {
              id: "node",
              self: "[Circular]",
            },
          },
          temperature: 0.1,
          maxOutputTokens: 50,
          systemInstruction: "follow system rules",
        },
      })
    );
  });
});
