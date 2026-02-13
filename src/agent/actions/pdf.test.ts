import { PDFActionDefinition } from "@/agent/actions/pdf";
import type { ActionContext } from "@/types";
import type { Page } from "playwright-core";

const generateContentMock = jest.fn();
const googleGenAIConstructorMock = jest.fn().mockImplementation(() => ({
  models: {
    generateContent: generateContentMock,
  },
}));

jest.mock("@google/genai", () => ({
  GoogleGenAI: function (...args: unknown[]) {
    return googleGenAIConstructorMock(...args);
  },
}));

function createResponse(options?: {
  ok?: boolean;
  contentType?: string;
  body?: Buffer;
}) {
  return {
    ok: jest.fn(() => options?.ok ?? true),
    headers: jest.fn(() => ({
      "content-type": options?.contentType ?? "application/pdf",
    })),
    body: jest.fn(async () => options?.body ?? Buffer.from("pdf")),
  };
}

function createContext(overrides?: Partial<ActionContext>): ActionContext {
  return {
    page: {
      request: {
        get: jest.fn(async () => createResponse()),
      },
      waitForResponse: jest.fn(async () => createResponse()),
      goto: jest.fn(async () => undefined),
    } as unknown as Page,
    domState: {
      elements: new Map(),
      domState: "",
      xpathMap: {},
      backendNodeMap: {},
    },
    llm: {
      invoke: async () => ({ role: "assistant", content: "ok" }),
      invokeStructured: async () => ({ rawText: "{}", parsed: null }),
      getProviderId: () => "mock",
      getModelId: () => "mock-model",
      getCapabilities: () => ({
        multimodal: false,
        toolCalling: true,
        jsonMode: true,
      }),
    },
    tokenLimit: 1000,
    variables: [],
    invalidateDomCache: jest.fn(),
    ...overrides,
  } as ActionContext;
}

describe("PDFActionDefinition", () => {
  const originalGeminiApiKey = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GEMINI_API_KEY = "test-gemini-key";
    generateContentMock.mockResolvedValue({ text: "PDF summary" });
  });

  afterAll(() => {
    process.env.GEMINI_API_KEY = originalGeminiApiKey;
  });

  it("returns failure when GEMINI_API_KEY is missing", async () => {
    delete process.env.GEMINI_API_KEY;
    const ctx = createContext();

    const result = await PDFActionDefinition.run(ctx, {
      pdfUrl: "https://example.com/file.pdf",
      prompt: "Summarize",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("GEMINI_API_KEY is not configured");
  });

  it("rejects unsupported URL protocols", async () => {
    const ctx = createContext();

    const result = await PDFActionDefinition.run(ctx, {
      pdfUrl: "file:///tmp/file.pdf",
      prompt: "Summarize",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('unsupported URL protocol "file:"');
  });

  it("uses direct PDF request when content-type is PDF", async () => {
    const requestGet = jest.fn(async () =>
      createResponse({
        ok: true,
        contentType: "application/pdf",
        body: Buffer.from("direct-pdf"),
      })
    );
    const ctx = createContext({
      page: {
        request: { get: requestGet },
        waitForResponse: jest.fn(),
        goto: jest.fn(),
      } as unknown as Page,
    });

    const result = await PDFActionDefinition.run(ctx, {
      pdfUrl: "https://example.com/file.pdf",
      prompt: "Summarize",
    });

    expect(result.success).toBe(true);
    expect(result.message).toBe("PDF summary");
    expect(requestGet).toHaveBeenCalledWith("https://example.com/file.pdf");
    expect(googleGenAIConstructorMock).toHaveBeenCalledWith({
      apiKey: "test-gemini-key",
    });
    expect(generateContentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: expect.arrayContaining([
          expect.objectContaining({ text: "Summarize" }),
          expect.objectContaining({
            inlineData: expect.objectContaining({
              mimeType: "application/pdf",
            }),
          }),
        ]),
      })
    );
  });

  it("falls back to waitForResponse/goto for non-direct PDF content", async () => {
    const requestGet = jest.fn(async () =>
      createResponse({
        ok: true,
        contentType: "text/html",
      })
    );
    const waitForResponse = jest.fn(async () =>
      createResponse({
        ok: true,
        contentType: "application/pdf",
        body: Buffer.from("fallback-pdf"),
      })
    );
    const goto = jest.fn(async () => undefined);
    const ctx = createContext({
      page: {
        request: { get: requestGet },
        waitForResponse,
        goto,
      } as unknown as Page,
    });

    const result = await PDFActionDefinition.run(ctx, {
      pdfUrl: "https://example.com/file.pdf",
      prompt: "Summarize",
    });

    expect(result.success).toBe(true);
    expect(waitForResponse).toHaveBeenCalledTimes(1);
    expect(goto).toHaveBeenCalledWith("https://example.com/file.pdf", {
      waitUntil: "networkidle",
    });
  });

  it("fails when page.request.get is unavailable", async () => {
    const ctx = createContext({
      page: {} as unknown as Page,
    });

    const result = await PDFActionDefinition.run(ctx, {
      pdfUrl: "https://example.com/file.pdf",
      prompt: "Summarize",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("page.request.get is unavailable");
  });

  it("rejects oversized PDF payloads", async () => {
    const requestGet = jest.fn(async () =>
      createResponse({
        ok: true,
        contentType: "application/pdf",
        body: Buffer.alloc(21 * 1024 * 1024, 1),
      })
    );
    const ctx = createContext({
      page: {
        request: { get: requestGet },
      } as unknown as Page,
    });

    const result = await PDFActionDefinition.run(ctx, {
      pdfUrl: "https://example.com/file.pdf",
      prompt: "Summarize",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("file exceeds");
  });

  it("returns readable failure when Gemini generation throws", async () => {
    generateContentMock.mockRejectedValue(new Error("gemini unavailable"));
    const ctx = createContext();

    const result = await PDFActionDefinition.run(ctx, {
      pdfUrl: "https://example.com/file.pdf",
      prompt: "Summarize",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("gemini unavailable");
  });

  it("sanitizes and truncates oversized PDF download failures", async () => {
    const requestGet = jest
      .fn()
      .mockRejectedValue(new Error(`download\u0000\n${"x".repeat(10_000)}`));
    const ctx = createContext({
      page: {
        request: { get: requestGet },
      } as unknown as Page,
    });

    const result = await PDFActionDefinition.run(ctx, {
      pdfUrl: "https://example.com/file.pdf",
      prompt: "Summarize",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Failed to download PDF:");
    expect(result.message).toContain("…");
    expect(result.message).not.toContain("\u0000");
    expect(result.message).not.toContain("\n");
    expect(result.message.length).toBeLessThan(750);
  });
});
