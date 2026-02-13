import type { HyperAgentLLM } from "@/llm/types";
import { findElementWithInstruction } from "@/agent/shared/find-element";

jest.mock("@/utils/waitForSettledDOM", () => ({
  waitForSettledDOM: jest.fn(),
}));

jest.mock("@/agent/shared/dom-capture", () => ({
  captureDOMState: jest.fn(),
}));

jest.mock("@/agent/examine-dom", () => ({
  examineDom: jest.fn(),
}));

const { waitForSettledDOM } = jest.requireMock(
  "@/utils/waitForSettledDOM"
) as {
  waitForSettledDOM: jest.Mock;
};

const { captureDOMState } = jest.requireMock(
  "@/agent/shared/dom-capture"
) as {
  captureDOMState: jest.Mock;
};

const { examineDom } = jest.requireMock(
  "@/agent/examine-dom"
) as {
  examineDom: jest.Mock;
};

function createMockLLM(): HyperAgentLLM {
  return {
    invoke: async () => ({ role: "assistant", content: "ok" }),
    invokeStructured: async () => ({ rawText: "{}", parsed: null }),
    getProviderId: () => "mock",
    getModelId: () => "mock-model",
    getCapabilities: () => ({
      multimodal: false,
      toolCalling: true,
      jsonMode: true,
    }),
  };
}

function createDomState() {
  return {
    elements: new Map([["0-1", { name: "button" }]]),
    domState: "dom tree",
    xpathMap: { "0-1": "//button[1]" },
    backendNodeMap: { "0-1": 111 },
  };
}

describe("findElementWithInstruction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    waitForSettledDOM.mockResolvedValue(undefined);
    captureDOMState.mockResolvedValue(createDomState());
  });

  it("retries element discovery and returns first found element", async () => {
    const page = {
      url: () => "https://example.com",
    } as unknown as import("playwright-core").Page;
    examineDom
      .mockResolvedValueOnce({
        elements: [],
        llmResponse: { rawText: "{}", parsed: null },
      })
      .mockResolvedValueOnce({
        elements: [{ elementId: "0-1", method: "click", args: [] }],
        llmResponse: { rawText: '{"ok":true}', parsed: { ok: true } },
      });

    const result = await findElementWithInstruction(
      "click login",
      page,
      createMockLLM(),
      {
        maxRetries: 2,
        retryDelayMs: 0,
      }
    );

    expect(result.success).toBe(true);
    expect(result.element).toEqual({ elementId: "0-1", method: "click", args: [] });
    expect(examineDom).toHaveBeenCalledTimes(2);
  });

  it("normalizes invalid maxRetries and returns fallback domState on capture errors", async () => {
    const page = {
      url: () => "https://example.com",
    } as unknown as import("playwright-core").Page;
    captureDOMState.mockRejectedValue(new Error("capture failed"));

    const result = await findElementWithInstruction(
      "click login",
      page,
      createMockLLM(),
      {
        maxRetries: 0,
        retryDelayMs: 0,
      }
    );

    expect(result.success).toBe(false);
    expect(result.domState.domState).toContain("capture failed");
    expect(captureDOMState).toHaveBeenCalledTimes(1);
  });

  it("truncates oversized fallback diagnostics on capture errors", async () => {
    const page = {
      url: () => "https://example.com",
    } as unknown as import("playwright-core").Page;
    captureDOMState.mockRejectedValue(new Error(`x${"y".repeat(2_000)}\ncapture failed`));

    const result = await findElementWithInstruction(
      "click login",
      page,
      createMockLLM(),
      {
        maxRetries: 1,
        retryDelayMs: 0,
      }
    );

    expect(result.success).toBe(false);
    expect(result.domState.domState).toContain("[truncated");
    expect(result.domState.domState).not.toContain("\n");
  });

  it("uses fallback page URL when page.url() getter throws", async () => {
    const page = {
      url: () => {
        throw new Error("url trap");
      },
    } as unknown as import("playwright-core").Page;
    examineDom.mockResolvedValue({
      elements: [],
      llmResponse: { rawText: "{}", parsed: null },
    });

    await findElementWithInstruction("click login", page, createMockLLM(), {
      maxRetries: 1,
      retryDelayMs: 0,
    });

    expect(examineDom).toHaveBeenCalledWith(
      "click login",
      expect.objectContaining({
        url: "about:blank",
      }),
      expect.any(Object)
    );
  });

  it("truncates oversized debug retry diagnostics", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const page = {
      url: () => "https://example.com",
    } as unknown as import("playwright-core").Page;
    captureDOMState.mockRejectedValue(new Error(`x${"y".repeat(2_000)}\ncapture failed`));

    try {
      await findElementWithInstruction(
        "click login",
        page,
        createMockLLM(),
        {
          maxRetries: 1,
          retryDelayMs: 0,
          debug: true,
        }
      );

      const warnMessage = String(warnSpy.mock.calls[0]?.[0] ?? "");
      expect(warnMessage).toContain("[truncated");
      expect(warnMessage).not.toContain("\n");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
