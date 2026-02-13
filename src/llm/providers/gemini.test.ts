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
});
