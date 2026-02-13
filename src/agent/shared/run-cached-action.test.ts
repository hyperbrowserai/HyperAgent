import { runCachedStep } from "@/agent/shared/run-cached-action";
import { TaskStatus } from "@/types/agent/types";
import type { HyperAgentLLM } from "@/llm/types";

jest.mock("uuid", () => ({
  v4: () => "task-uuid",
}));

jest.mock("@/agent/shared/replay-special-actions", () => ({
  executeReplaySpecialAction: jest.fn(),
}));

jest.mock("@/utils/waitForSettledDOM", () => ({
  waitForSettledDOM: jest.fn(),
}));

jest.mock("@/context-providers/a11y-dom/dom-cache", () => ({
  markDomSnapshotDirty: jest.fn(),
}));

jest.mock("@/agent/shared/dom-capture", () => ({
  captureDOMState: jest.fn(),
}));

jest.mock("@/agent/shared/runtime-context", () => ({
  initializeRuntimeContext: jest.fn(),
}));

jest.mock("@/agent/shared/xpath-cdp-resolver", () => ({
  resolveXPathWithCDP: jest.fn(),
}));

jest.mock("@/agent/actions/shared/perform-action", () => ({
  performAction: jest.fn(),
}));

const { executeReplaySpecialAction } = jest.requireMock(
  "@/agent/shared/replay-special-actions"
) as {
  executeReplaySpecialAction: jest.Mock;
};

const { waitForSettledDOM } = jest.requireMock(
  "@/utils/waitForSettledDOM"
) as {
  waitForSettledDOM: jest.Mock;
};

const { captureDOMState } = jest.requireMock("@/agent/shared/dom-capture") as {
  captureDOMState: jest.Mock;
};

const { initializeRuntimeContext } = jest.requireMock(
  "@/agent/shared/runtime-context"
) as {
  initializeRuntimeContext: jest.Mock;
};

const { resolveXPathWithCDP } = jest.requireMock(
  "@/agent/shared/xpath-cdp-resolver"
) as {
  resolveXPathWithCDP: jest.Mock;
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

function createMockPage() {
  return {
    goto: jest.fn().mockResolvedValue(undefined),
    waitForTimeout: jest.fn().mockResolvedValue(undefined),
    reload: jest.fn().mockResolvedValue(undefined),
  } as unknown as import("playwright-core").Page;
}

describe("runCachedStep", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    waitForSettledDOM.mockResolvedValue(undefined);
    captureDOMState.mockResolvedValue({
      elements: new Map(),
      domState: "",
      xpathMap: {},
      backendNodeMap: {},
    });
    initializeRuntimeContext.mockResolvedValue({
      cdpClient: {},
      frameContextManager: {},
    });
  });

  it("uses shared special action result and normalizes retries", async () => {
    executeReplaySpecialAction.mockResolvedValue({
      taskId: "task-uuid",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "Task Complete",
      replayStepMeta: {
        usedCachedAction: true,
        fallbackUsed: false,
        retries: 0,
        cachedXPath: null,
        fallbackXPath: null,
        fallbackElementId: null,
      },
    });

    const result = await runCachedStep({
      page: createMockPage(),
      instruction: "done",
      cachedAction: {
        actionType: "complete",
      },
      tokenLimit: 8000,
      llm: createMockLLM(),
      mcpClient: undefined,
      variables: [],
    });

    expect(result.status).toBe(TaskStatus.COMPLETED);
    expect(result.replayStepMeta?.retries).toBe(1);
  });

  it("returns unsupported error for non-special non-actElement actions", async () => {
    executeReplaySpecialAction.mockResolvedValue(null);

    const result = await runCachedStep({
      page: createMockPage(),
      instruction: "noop",
      cachedAction: {
        actionType: "unknown",
      },
      tokenLimit: 8000,
      llm: createMockLLM(),
      mcpClient: undefined,
      variables: [],
    });

    expect(result.status).toBe(TaskStatus.FAILED);
    expect(result.output).toBe("Unsupported cached action");
  });

  it("falls back to perform when cached attempts fail", async () => {
    executeReplaySpecialAction.mockResolvedValue(null);
    resolveXPathWithCDP.mockRejectedValue(new Error("xpath resolution failed"));
    const performFallback = jest.fn().mockResolvedValue({
      taskId: "fallback-task",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "fallback completed",
      replayStepMeta: {
        usedCachedAction: false,
        fallbackUsed: true,
        retries: 1,
        fallbackXPath: "/html/body/button[1]",
        fallbackElementId: "0-1",
      },
    });
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      const result = await runCachedStep({
        page: createMockPage(),
        instruction: "click login",
        cachedAction: {
          actionType: "actElement",
          xpath: "//button[1]",
          method: "click",
          frameIndex: 0,
          arguments: [],
        },
        maxSteps: 1,
        tokenLimit: 8000,
        llm: createMockLLM(),
        mcpClient: undefined,
        variables: [],
        performFallback,
      });

      expect(performFallback).toHaveBeenCalledWith("click login");
      expect(result.status).toBe(TaskStatus.COMPLETED);
      expect(result.replayStepMeta).toEqual(
        expect.objectContaining({
          usedCachedAction: true,
          fallbackUsed: true,
          retries: 1,
          cachedXPath: "//button[1]",
          fallbackXPath: "/html/body/button[1]",
          fallbackElementId: "0-1",
        })
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("returns failed replay metadata when cached attempts exhaust", async () => {
    executeReplaySpecialAction.mockResolvedValue(null);
    resolveXPathWithCDP.mockRejectedValue(new Error("xpath resolution failed"));

    const result = await runCachedStep({
      page: createMockPage(),
      instruction: "click login",
      cachedAction: {
        actionType: "actElement",
        xpath: "//button[1]",
        method: "click",
        frameIndex: 0,
        arguments: [],
      },
      maxSteps: 2,
      tokenLimit: 8000,
      llm: createMockLLM(),
      mcpClient: undefined,
      variables: [],
    });

    expect(result.status).toBe(TaskStatus.FAILED);
    expect(result.output).toContain("xpath resolution failed");
    expect(result.replayStepMeta).toEqual(
      expect.objectContaining({
        usedCachedAction: true,
        fallbackUsed: false,
        retries: 2,
        cachedXPath: "//button[1]",
      })
    );
  });
});
