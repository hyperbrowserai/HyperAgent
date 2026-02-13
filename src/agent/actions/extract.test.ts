import fs from "fs";
import {
  ExtractActionDefinition,
  estimateTextTokenCount,
  trimMarkdownToTokenLimit,
} from "@/agent/actions/extract";
import type { ActionContext } from "@/types";
import type { HyperAgentLLM } from "@/llm/types";

jest.mock("@/utils/html-to-markdown", () => ({
  parseMarkdown: jest.fn(),
}));

jest.mock("@/cdp", () => ({
  getCDPClient: jest.fn(),
}));

const { parseMarkdown } = jest.requireMock("@/utils/html-to-markdown") as {
  parseMarkdown: jest.Mock;
};

const { getCDPClient } = jest.requireMock("@/cdp") as {
  getCDPClient: jest.Mock;
};

function createMockLLM(
  invokeMock?: jest.Mock,
  options?: { multimodal?: boolean }
): HyperAgentLLM {
  return {
    invoke: invokeMock
      ? (async (messages) => invokeMock(messages))
      : async () => ({
        role: "assistant",
        content: "extracted output",
        }),
    invokeStructured: async () => ({ rawText: "{}", parsed: null }),
    getProviderId: () => "mock",
    getModelId: () => "mock-model",
    getCapabilities: () => ({
      multimodal: options?.multimodal ?? true,
      toolCalling: true,
      jsonMode: true,
    }),
  };
}

function createContext(
  llm?: HyperAgentLLM,
  overrides?: Partial<ActionContext>
): ActionContext {
  return {
    page: {
      content: jest.fn().mockResolvedValue("<html>demo</html>"),
    } as unknown as ActionContext["page"],
    domState: {
      elements: new Map(),
      domState: "",
      xpathMap: {},
      backendNodeMap: {},
    },
    llm: llm ?? createMockLLM(),
    tokenLimit: 200,
    variables: [],
    invalidateDomCache: jest.fn(),
    ...overrides,
  } as ActionContext;
}

describe("extract action token helpers", () => {
  it("returns zero tokens for empty or whitespace-only content", () => {
    expect(estimateTextTokenCount("")).toBe(0);
    expect(estimateTextTokenCount("   \n\t")).toBe(0);
  });

  it("estimates token count as positive non-zero", () => {
    expect(estimateTextTokenCount("hello world")).toBeGreaterThan(0);
  });

  it("trims markdown and appends truncation notice when over limit", () => {
    const markdown = "a".repeat(2000);
    const trimmed = trimMarkdownToTokenLimit(markdown, 20);

    expect(trimmed).toContain("[Content truncated due to token limit]");
    expect(trimmed.length).toBeLessThan(markdown.length);
  });
});

describe("ExtractActionDefinition.run", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    parseMarkdown.mockResolvedValue("page markdown content");
    getCDPClient.mockResolvedValue({
      acquireSession: jest.fn().mockResolvedValue({
        send: jest.fn().mockResolvedValue({ data: "abc" }),
      }),
    });
  });

  it("falls back to markdown-only extraction when screenshot capture fails", async () => {
    getCDPClient.mockRejectedValue(new Error("cdp unavailable"));
    const invoke = jest.fn().mockResolvedValue({
      role: "assistant",
      content: "fallback extraction",
    });
    const ctx = createContext(createMockLLM(invoke));

    const result = await ExtractActionDefinition.run(ctx, {
      objective: "Extract price",
    });

    expect(result.success).toBe(true);
    expect(invoke).toHaveBeenCalled();
    const messagesArg = invoke.mock.calls[0]?.[0];
    const contentParts = messagesArg?.[0]?.content as Array<{
      type: string;
      url?: string;
    }>;
    expect(contentParts).toHaveLength(1);
    expect(contentParts[0]?.type).toBe("text");
  });

  it("fails fast when extraction objective is empty", async () => {
    const invoke = jest.fn().mockResolvedValue({
      role: "assistant",
      content: "should not be called",
    });
    const ctx = createContext(createMockLLM(invoke));

    const result = await ExtractActionDefinition.run(ctx, {
      objective: "   ",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("objective cannot be empty");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not fail when debug file writes throw", async () => {
    const writeSpy = jest.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const ctx = createContext(undefined, { debugDir: "debug", debug: true });

    try {
      const result = await ExtractActionDefinition.run(ctx, {
        objective: "Extract title",
      });
      expect(result.success).toBe(true);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("prepares debug directory before writing artifacts", async () => {
    const mkdirSpy = jest
      .spyOn(fs, "mkdirSync")
      .mockImplementation(() => undefined);
    const ctx = createContext(undefined, { debugDir: "debug", debug: true });

    try {
      const result = await ExtractActionDefinition.run(ctx, {
        objective: "Extract title",
      });
      expect(result.success).toBe(true);
      expect(mkdirSpy).toHaveBeenCalledWith("debug", { recursive: true });
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  it("returns failure when llm responds without text content", async () => {
    const emptyTextLlm = createMockLLM(
      jest.fn().mockResolvedValue({
      role: "assistant",
      content: [{ type: "tool_call", toolName: "noop", arguments: {} }],
      })
    );
    const ctx = createContext(emptyTextLlm);

    const result = await ExtractActionDefinition.run(ctx, {
      objective: "Extract content",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("No content extracted");
  });

  it("returns failure when llm text content is only whitespace", async () => {
    const whitespaceLlm = createMockLLM(
      jest.fn().mockResolvedValue({
        role: "assistant",
        content: "   \n\t  ",
      })
    );
    const ctx = createContext(whitespaceLlm);

    const result = await ExtractActionDefinition.run(ctx, {
      objective: "Extract content",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("No content extracted");
  });

  it("returns formatted root error messages", async () => {
    const pageContent = jest
      .fn()
      .mockRejectedValue(new Error("page content unavailable"));
    const ctx = createContext(undefined, {
      page: {
        content: pageContent,
      } as unknown as ActionContext["page"],
    });

    const result = await ExtractActionDefinition.run(ctx, {
      objective: "Extract content",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("page content unavailable");
  });

  it("applies markdown token budget based on overall token limit", async () => {
    getCDPClient.mockRejectedValue(new Error("cdp unavailable"));
    parseMarkdown.mockResolvedValue("token ".repeat(3000));
    const invoke = jest.fn().mockResolvedValue({
      role: "assistant",
      content: "budgeted extraction",
    });
    const ctx = createContext(createMockLLM(invoke), { tokenLimit: 120 });

    await ExtractActionDefinition.run(ctx, {
      objective: "Extract concise summary",
    });

    const messages = invoke.mock.calls[0]?.[0] as Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;
    const promptText = messages[0]?.content?.[0]?.text ?? "";
    expect(promptText).toContain("[Content truncated due to token limit]");
    expect(estimateTextTokenCount(promptText)).toBeLessThanOrEqual(120);
  });

  it("uses default token limit when provided limit is invalid", async () => {
    getCDPClient.mockRejectedValue(new Error("cdp unavailable"));
    parseMarkdown.mockResolvedValue("token ".repeat(6000));
    const invoke = jest.fn().mockResolvedValue({
      role: "assistant",
      content: "default budget extraction",
    });
    const ctx = createContext(createMockLLM(invoke), { tokenLimit: NaN });

    const result = await ExtractActionDefinition.run(ctx, {
      objective: "Extract summary",
    });

    expect(result.success).toBe(true);
    const messages = invoke.mock.calls[0]?.[0] as Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;
    const promptText = messages[0]?.content?.[0]?.text ?? "";
    expect(promptText).toContain("[Content truncated due to token limit]");
    expect(estimateTextTokenCount(promptText)).toBeLessThanOrEqual(4000);
  });

  it("falls back to plain text extraction when markdown conversion fails", async () => {
    parseMarkdown.mockRejectedValue(new Error("markdown parse failed"));
    const invoke = jest.fn().mockResolvedValue({
      role: "assistant",
      content: "fallback markdown extraction",
    });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = createContext(createMockLLM(invoke), { debug: true });

    try {
      const result = await ExtractActionDefinition.run(ctx, {
        objective: "Extract content",
      });

      expect(result.success).toBe(true);
      expect(warnSpy).toHaveBeenCalled();
      const messages = invoke.mock.calls[0]?.[0] as Array<{
        content: Array<{ type: string; text?: string }>;
      }>;
      const promptText = messages[0]?.content?.[0]?.text ?? "";
      expect(promptText).toContain("demo");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("skips screenshot content when model is not multimodal", async () => {
    const invoke = jest.fn().mockResolvedValue({
      role: "assistant",
      content: "non multimodal extraction",
    });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = createContext(createMockLLM(invoke, { multimodal: false }), {
      debug: true,
    });

    try {
      const result = await ExtractActionDefinition.run(ctx, {
        objective: "Extract content",
      });

      expect(result.success).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        "[extract] LLM does not support multimodal input; proceeding without screenshot."
      );

      const messages = invoke.mock.calls[0]?.[0] as Array<{
        content: Array<{ type: string }>;
      }>;
      expect(messages[0]?.content).toHaveLength(1);
      expect(messages[0]?.content?.[0]?.type).toBe("text");
      expect(getCDPClient).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
