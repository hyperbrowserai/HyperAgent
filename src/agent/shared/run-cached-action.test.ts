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

const { performAction } = jest.requireMock(
  "@/agent/actions/shared/perform-action"
) as {
  performAction: jest.Mock;
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
    performAction.mockResolvedValue({
      success: true,
      message: "ok",
    });
  });

  it("uses shared special action result metadata", async () => {
    executeReplaySpecialAction.mockResolvedValue({
      taskId: "task-uuid",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "Task Complete",
      replayStepMeta: {
        usedCachedAction: true,
        fallbackUsed: false,
        retries: 1,
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
    expect(result.replayStepMeta).toEqual(
      expect.objectContaining({
        usedCachedAction: true,
        fallbackUsed: false,
        retries: 1,
      })
    );
  });

  it("treats whitespace xpath or method as unsupported cached action", async () => {
    executeReplaySpecialAction.mockResolvedValue(null);

    const whitespaceXPathResult = await runCachedStep({
      page: createMockPage(),
      instruction: "click login",
      cachedAction: {
        actionType: "actElement",
        xpath: "   ",
        method: "click",
      },
      tokenLimit: 8000,
      llm: createMockLLM(),
      mcpClient: undefined,
      variables: [],
    });

    const whitespaceMethodResult = await runCachedStep({
      page: createMockPage(),
      instruction: "click login",
      cachedAction: {
        actionType: "actElement",
        xpath: "//button[1]",
        method: "   ",
      },
      tokenLimit: 8000,
      llm: createMockLLM(),
      mcpClient: undefined,
      variables: [],
    });

    expect(whitespaceXPathResult.status).toBe(TaskStatus.FAILED);
    expect(whitespaceXPathResult.output).toBe("Unsupported cached action");
    expect(whitespaceMethodResult.status).toBe(TaskStatus.FAILED);
    expect(whitespaceMethodResult.output).toBe("Unsupported cached action");
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
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("logs cached fallback diagnostics only in debug mode", async () => {
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
      await runCachedStep({
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
        debug: true,
        tokenLimit: 8000,
        llm: createMockLLM(),
        mcpClient: undefined,
        variables: [],
        performFallback,
      });

      expect(logSpy).toHaveBeenCalledTimes(1);
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

  it("returns failed task output when special action execution throws", async () => {
    executeReplaySpecialAction.mockRejectedValue(new Error("navigation failed"));

    const result = await runCachedStep({
      page: createMockPage(),
      instruction: "go to app",
      cachedAction: {
        actionType: "goToUrl",
        arguments: ["https://example.com"],
      },
      tokenLimit: 8000,
      llm: createMockLLM(),
      mcpClient: undefined,
      variables: [],
    });

    expect(result.status).toBe(TaskStatus.FAILED);
    expect(result.output).toContain("Failed to execute cached special action");
    expect(result.output).toContain("navigation failed");
    expect(result.replayStepMeta).toEqual(
      expect.objectContaining({
        usedCachedAction: true,
        fallbackUsed: false,
        retries: 1,
      })
    );
  });

  it("truncates oversized special-action failure diagnostics", async () => {
    executeReplaySpecialAction.mockRejectedValue(
      new Error(`x${"y".repeat(2_000)}\nnavigation failed`)
    );

    const result = await runCachedStep({
      page: createMockPage(),
      instruction: "go to app",
      cachedAction: {
        actionType: "goToUrl",
        arguments: ["https://example.com"],
      },
      tokenLimit: 8000,
      llm: createMockLLM(),
      mcpClient: undefined,
      variables: [],
    });

    expect(result.status).toBe(TaskStatus.FAILED);
    expect(result.output).toContain("[truncated");
    expect(result.output).not.toContain("\n");
  });

  it("returns failed output when perform fallback throws", async () => {
    executeReplaySpecialAction.mockResolvedValue(null);
    resolveXPathWithCDP.mockRejectedValue(new Error("xpath resolution failed"));
    const performFallback = jest
      .fn()
      .mockRejectedValue(new Error("perform fallback crashed"));

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

    expect(result.status).toBe(TaskStatus.FAILED);
    expect(result.output).toContain("Fallback perform failed");
    expect(result.output).toContain("perform fallback crashed");
    expect(result.replayStepMeta).toEqual(
      expect.objectContaining({
        usedCachedAction: true,
        fallbackUsed: true,
        retries: 1,
        cachedXPath: "//button[1]",
      })
    );
  });

  it("truncates oversized fallback failure diagnostics", async () => {
    executeReplaySpecialAction.mockResolvedValue(null);
    resolveXPathWithCDP.mockRejectedValue(new Error("xpath resolution failed"));
    const performFallback = jest
      .fn()
      .mockRejectedValue(new Error(`x${"y".repeat(2_000)}\nperform fallback crashed`));

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

    expect(result.status).toBe(TaskStatus.FAILED);
    expect(result.output).toContain("[truncated");
    expect(result.output).not.toContain("\n");
  });

  it("normalizes invalid fallback responses safely", async () => {
    executeReplaySpecialAction.mockResolvedValue(null);
    resolveXPathWithCDP.mockRejectedValue(new Error("xpath resolution failed"));
    const performFallback = jest.fn().mockResolvedValue("not-an-object");

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

    expect(result.status).toBe(TaskStatus.FAILED);
    expect(result.output).toContain("invalid response payload");
    expect(result.replayStepMeta).toEqual(
      expect.objectContaining({
        usedCachedAction: true,
        fallbackUsed: true,
        retries: 1,
        cachedXPath: "//button[1]",
      })
    );
  });

  it("handles trap-prone fallback replay metadata getters safely", async () => {
    executeReplaySpecialAction.mockResolvedValue(null);
    resolveXPathWithCDP.mockRejectedValue(new Error("xpath resolution failed"));
    const replayStepMeta = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "fallbackXPath" || prop === "fallbackElementId") {
            throw new Error("fallback meta trap");
          }
          return undefined;
        },
      }
    );
    const performFallback = jest.fn().mockResolvedValue({
      taskId: "fallback-task",
      status: TaskStatus.COMPLETED,
      output: "fallback done",
      replayStepMeta,
    });

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

    expect(result.status).toBe(TaskStatus.COMPLETED);
    expect(result.replayStepMeta).toEqual(
      expect.objectContaining({
        fallbackXPath: null,
        fallbackElementId: null,
      })
    );
  });

  it("normalizes invalid maxSteps values to a single attempt", async () => {
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
      maxSteps: 0,
      tokenLimit: 8000,
      llm: createMockLLM(),
      mcpClient: undefined,
      variables: [],
    });

    expect(result.status).toBe(TaskStatus.FAILED);
    expect(result.replayStepMeta?.retries).toBe(1);
  });

  it("surfaces non-Error throw values from cached attempts", async () => {
    executeReplaySpecialAction.mockResolvedValue(null);
    resolveXPathWithCDP.mockRejectedValue("string failure");

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
    });

    expect(result.status).toBe(TaskStatus.FAILED);
    expect(result.output).toContain("string failure");
  });

  it("truncates oversized cached attempt failure diagnostics", async () => {
    executeReplaySpecialAction.mockResolvedValue(null);
    resolveXPathWithCDP.mockRejectedValue(new Error(`x${"y".repeat(5_000)}`));

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
    });

    expect(result.status).toBe(TaskStatus.FAILED);
    expect(result.output).toContain("[truncated");
    expect(String(result.output ?? "").length).toBeLessThanOrEqual(4100);
  });

  it("handles trap-prone cached-action getters safely", async () => {
    executeReplaySpecialAction.mockResolvedValue(null);
    const cachedAction = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (
            prop === "actionType" ||
            prop === "xpath" ||
            prop === "method" ||
            prop === "arguments" ||
            prop === "frameIndex" ||
            prop === "actionParams"
          ) {
            throw new Error("cached-action getter trap");
          }
          return undefined;
        },
      }
    );

    const result = await runCachedStep({
      page: createMockPage(),
      instruction: "click login",
      cachedAction: cachedAction as unknown as Parameters<typeof runCachedStep>[0]["cachedAction"],
      tokenLimit: 8000,
      llm: createMockLLM(),
      mcpClient: undefined,
      variables: [],
    });

    expect(result.status).toBe(TaskStatus.FAILED);
    expect(result.output).toBe("Unsupported cached action");
  });

  it("normalizes cached arguments and frame index before action replay", async () => {
    executeReplaySpecialAction.mockResolvedValue(null);
    resolveXPathWithCDP.mockResolvedValue({
      backendNodeId: 222,
      frameId: "frame-1",
      objectId: "obj-1",
      session: {},
    });
    performAction.mockResolvedValue({
      success: true,
      message: "clicked",
    });
    const oversizedArg = "x".repeat(3_500);
    const manyArgs = Array.from({ length: 30 }, (_, i) => i);

    const result = await runCachedStep({
      page: createMockPage(),
      instruction: "click login",
      cachedAction: {
        actionType: "actElement",
        xpath: "//button[1]",
        method: "click",
        frameIndex: Number.NaN as unknown as number,
        arguments: [0, null as unknown as string, oversizedArg, ...manyArgs],
      },
      maxSteps: 1,
      tokenLimit: 8000,
      llm: createMockLLM(),
      mcpClient: undefined,
      variables: [],
    });

    expect(result.status).toBe(TaskStatus.COMPLETED);
    const callArgs = performAction.mock.calls[0]?.[1] as {
      arguments: string[];
    };
    expect(callArgs.arguments[0]).toBe("0");
    expect(callArgs.arguments[1]).toBe("");
    expect(callArgs.arguments[2]?.length).toBe(2000);
    expect(callArgs.arguments.length).toBeLessThanOrEqual(20);
    expect(resolveXPathWithCDP).toHaveBeenCalledWith(
      expect.objectContaining({
        frameIndex: 0,
      })
    );
  });
});
