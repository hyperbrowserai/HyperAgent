import type { Page } from "playwright-core";
import { HyperAgent } from "@/agent";
import type { HyperAgentLLM } from "@/llm/types";
import { TaskStatus } from "@/types";

jest.mock("@/agent/shared/find-element", () => ({
  findElementWithInstruction: jest.fn(),
}));

jest.mock("@/agent/actions/shared/perform-action", () => ({
  performAction: jest.fn(),
}));

jest.mock("@/agent/shared/runtime-context", () => ({
  initializeRuntimeContext: jest.fn(),
}));

jest.mock("@/utils/waitForSettledDOM", () => ({
  waitForSettledDOM: jest.fn(),
}));

jest.mock("@/utils/debugWriter", () => ({
  writeAiActionDebug: jest.fn(),
}));

jest.mock("@/context-providers/a11y-dom/dom-cache", () => ({
  markDomSnapshotDirty: jest.fn(),
}));

const { findElementWithInstruction } = jest.requireMock(
  "@/agent/shared/find-element"
) as {
  findElementWithInstruction: jest.Mock;
};

const { performAction } = jest.requireMock(
  "@/agent/actions/shared/perform-action"
) as {
  performAction: jest.Mock;
};

const { initializeRuntimeContext } = jest.requireMock(
  "@/agent/shared/runtime-context"
) as {
  initializeRuntimeContext: jest.Mock;
};

const { waitForSettledDOM } = jest.requireMock(
  "@/utils/waitForSettledDOM"
) as {
  waitForSettledDOM: jest.Mock;
};

const { writeAiActionDebug } = jest.requireMock(
  "@/utils/debugWriter"
) as {
  writeAiActionDebug: jest.Mock;
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

describe("HyperAgent.executeSingleAction retry options", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    findElementWithInstruction.mockResolvedValue({
      success: true,
      element: {
        elementId: "0-1",
        method: "click",
        arguments: [],
        confidence: 1,
        description: "button",
      },
      domState: {
        elements: new Map([["0-1", { role: "button" }]]),
        domState: "dom",
        xpathMap: { "0-1": "//button[1]" },
        backendNodeMap: {},
      },
      elementMap: new Map([["0-1", { role: "button" }]]),
      llmResponse: {
        rawText: "{}",
        parsed: {},
      },
    });
    initializeRuntimeContext.mockResolvedValue({
      cdpClient: {},
      frameContextManager: {},
    });
    performAction.mockResolvedValue({
      success: true,
      message: "ok",
    });
    waitForSettledDOM.mockResolvedValue({
      durationMs: 1,
      lifecycleMs: 0,
      networkMs: 1,
      requestsSeen: 0,
      peakInflight: 0,
      resolvedByTimeout: false,
      forcedDrops: 0,
    });
  });

  it("passes maxElementRetries and retryDelayMs to findElementWithInstruction", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: false,
      cdpActions: false,
    });
    const page = {
      url: () => "https://example.com",
    } as unknown as Page;

    await agent.executeSingleAction("click login", page, {
      maxElementRetries: 7,
      retryDelayMs: 42,
      maxContextSwitchRetries: 2,
    });

    expect(findElementWithInstruction).toHaveBeenCalledWith(
      "click login",
      page,
      expect.any(Object),
      expect.objectContaining({
        maxRetries: 7,
        retryDelayMs: 42,
      })
    );
  });

  it("formats non-Error execution failures with readable messages", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: false,
      cdpActions: false,
    });
    const page = {
      url: () => "https://example.com",
    } as unknown as Page;
    performAction.mockRejectedValue({ reason: "perform crashed" });

    await expect(
      agent.executeSingleAction("click login", page, {
        maxElementRetries: 1,
      })
    ).rejects.toThrow(
      'Failed to execute action: {"reason":"perform crashed"}'
    );
  });

  it("formats non-Error failure payloads written to aiAction debug artifacts", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: true,
      cdpActions: false,
    });
    const page = {
      url: () => "https://example.com",
      screenshot: jest.fn().mockResolvedValue(Buffer.from("screenshot")),
    } as unknown as Page;
    performAction.mockRejectedValue({ reason: "perform crashed" });
    writeAiActionDebug.mockResolvedValue(undefined);
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(
        agent.executeSingleAction("click login", page, {
          maxElementRetries: 1,
        })
      ).rejects.toThrow(
        'Failed to execute action: {"reason":"perform crashed"}'
      );

      expect(writeAiActionDebug).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            message: '{"reason":"perform crashed"}',
          }),
        })
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("formats non-Error aiAction debug writer failures", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: true,
      cdpActions: false,
    });
    const page = {
      url: () => "https://example.com",
      screenshot: jest.fn().mockResolvedValue(Buffer.from("screenshot")),
    } as unknown as Page;
    writeAiActionDebug.mockRejectedValue({ reason: "debug writer crashed" });
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      const result = await agent.executeSingleAction("click login", page, {
        maxElementRetries: 1,
      });

      expect(result.status).toBe(TaskStatus.COMPLETED);
      expect(errorSpy).toHaveBeenCalledWith(
        '[aiAction] Failed to write debug data: {"reason":"debug writer crashed"}'
      );
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
