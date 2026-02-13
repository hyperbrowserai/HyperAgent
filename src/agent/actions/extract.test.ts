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

function createMockLLM(invokeMock?: jest.Mock): HyperAgentLLM {
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
      multimodal: true,
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
});
