const createOpenAIClientMock = jest.fn();
const createAnthropicClientMock = jest.fn();
const createGeminiClientMock = jest.fn();
const createDeepSeekClientMock = jest.fn();

jest.mock("@/llm/providers/openai", () => ({
  createOpenAIClient: (...args: unknown[]) => createOpenAIClientMock(...args),
}));

jest.mock("@/llm/providers/anthropic", () => ({
  createAnthropicClient: (...args: unknown[]) =>
    createAnthropicClientMock(...args),
}));

jest.mock("@/llm/providers/gemini", () => ({
  createGeminiClient: (...args: unknown[]) => createGeminiClientMock(...args),
}));

jest.mock("@/llm/providers/deepseek", () => ({
  createDeepSeekClient: (...args: unknown[]) =>
    createDeepSeekClientMock(...args),
}));

import { createLLMClient, LLMConfig } from "@/llm/providers";

describe("createLLMClient", () => {
  beforeEach(() => {
    createOpenAIClientMock.mockReset();
    createAnthropicClientMock.mockReset();
    createGeminiClientMock.mockReset();
    createDeepSeekClientMock.mockReset();
    createOpenAIClientMock.mockReturnValue({ provider: "openai" });
    createAnthropicClientMock.mockReturnValue({ provider: "anthropic" });
    createGeminiClientMock.mockReturnValue({ provider: "gemini" });
    createDeepSeekClientMock.mockReturnValue({ provider: "deepseek" });
  });

  it("normalizes provider/model/baseURL and numeric values", () => {
    const client = createLLMClient({
      provider: " OpenAI " as unknown as LLMConfig["provider"],
      model: " gpt-4o-mini ",
      temperature: Number.NaN,
      maxTokens: 120.7,
      baseURL: " https://example.com/v1 ",
    });

    expect(client).toEqual({ provider: "openai" });
    expect(createOpenAIClientMock).toHaveBeenCalledWith({
      apiKey: undefined,
      model: "gpt-4o-mini",
      temperature: undefined,
      maxTokens: 120,
      baseURL: "https://example.com/v1",
    });
  });

  it("normalizes deepseek config and drops invalid maxTokens", () => {
    const client = createLLMClient({
      provider: "deepseek",
      model: " deepseek-reasoner ",
      maxTokens: 0,
      baseURL: " ",
    });

    expect(client).toEqual({ provider: "deepseek" });
    expect(createDeepSeekClientMock).toHaveBeenCalledWith({
      apiKey: undefined,
      model: "deepseek-reasoner",
      temperature: undefined,
      maxTokens: undefined,
      baseURL: undefined,
    });
  });

  it("rejects unsupported provider values", () => {
    expect(() =>
      createLLMClient({
        provider: "mystery" as unknown as LLMConfig["provider"],
        model: "model",
      })
    ).toThrow("Unsupported provider: mystery");
  });

  it("rejects empty model values", () => {
    expect(() =>
      createLLMClient({
        provider: "openai",
        model: "   ",
      })
    ).toThrow("LLM model must be a non-empty string");
  });
});
