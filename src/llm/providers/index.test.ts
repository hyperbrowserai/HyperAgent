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

  it("normalizes apiKey and trims trailing baseURL slash", () => {
    createLLMClient({
      provider: "openai",
      apiKey: "  key-123  ",
      model: "model",
      baseURL: "https://example.com/v1/",
    });

    expect(createOpenAIClientMock).toHaveBeenCalledWith({
      apiKey: "key-123",
      model: "model",
      temperature: undefined,
      maxTokens: undefined,
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

  it("drops out-of-range temperatures and preserves valid values", () => {
    createLLMClient({
      provider: "openai",
      model: "model",
      temperature: 2.5,
    });
    expect(createOpenAIClientMock).toHaveBeenLastCalledWith({
      apiKey: undefined,
      model: "model",
      temperature: undefined,
      maxTokens: undefined,
      baseURL: undefined,
    });

    createLLMClient({
      provider: "openai",
      model: "model",
      temperature: 1.25,
    });
    expect(createOpenAIClientMock).toHaveBeenLastCalledWith({
      apiKey: undefined,
      model: "model",
      temperature: 1.25,
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

  it("strips control characters from model identifiers", () => {
    createLLMClient({
      provider: "openai",
      model: "gpt-\u0000test",
    });

    expect(createOpenAIClientMock).toHaveBeenCalledWith({
      apiKey: undefined,
      model: "gpt-test",
      temperature: undefined,
      maxTokens: undefined,
      baseURL: undefined,
    });
  });

  it("rejects excessively long model identifiers", () => {
    const hugeModel = "m".repeat(300);
    expect(() =>
      createLLMClient({
        provider: "openai",
        model: hugeModel,
      })
    ).toThrow("LLM model exceeds maximum length of 200 characters");
  });

  it("rejects invalid baseURL values", () => {
    expect(() =>
      createLLMClient({
        provider: "openai",
        model: "model",
        baseURL: "not-a-url",
      })
    ).toThrow("Invalid LLM baseURL: not-a-url");
  });

  it("rejects unsupported baseURL protocols", () => {
    expect(() =>
      createLLMClient({
        provider: "openai",
        model: "model",
        baseURL: "ftp://example.com/path",
      })
    ).toThrow("Invalid LLM baseURL protocol: ftp:");
  });

  it("ignores invalid baseURL for providers that do not use it", () => {
    expect(() =>
      createLLMClient({
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        baseURL: "not-a-url",
      })
    ).not.toThrow();

    expect(createAnthropicClientMock).toHaveBeenCalledWith({
      apiKey: undefined,
      model: "claude-3-5-sonnet",
      temperature: undefined,
      maxTokens: undefined,
    });
  });
});
