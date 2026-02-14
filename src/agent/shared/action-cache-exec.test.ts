import {
  attachCachedActionHelpers,
  dispatchPerformHelper,
  isPageActionMethod,
  normalizePageActionMethod,
} from "@/agent/shared/action-cache-exec";
import type { AgentDeps, HyperPage, PerformOptions } from "@/types/agent/types";
import type { HyperAgentLLM } from "@/llm/types";

jest.mock("@/agent/shared/run-cached-action", () => ({
  runCachedStep: jest.fn().mockResolvedValue({
    taskId: "task-id",
    status: "completed",
    steps: [],
    output: "ok",
  }),
}));

const { runCachedStep } = jest.requireMock("@/agent/shared/run-cached-action") as {
  runCachedStep: jest.Mock;
};

function createMockHyperPage(): HyperPage {
  const ok = Promise.resolve({
    taskId: "task-id",
    status: "completed",
    steps: [],
    output: "ok",
  });
  return {
    performClick: jest.fn().mockReturnValue(ok),
    performHover: jest.fn().mockReturnValue(ok),
    performType: jest.fn().mockReturnValue(ok),
    performFill: jest.fn().mockReturnValue(ok),
    performPress: jest.fn().mockReturnValue(ok),
    performSelectOption: jest.fn().mockReturnValue(ok),
    performCheck: jest.fn().mockReturnValue(ok),
    performUncheck: jest.fn().mockReturnValue(ok),
    performScrollToElement: jest.fn().mockReturnValue(ok),
    performScrollToPercentage: jest.fn().mockReturnValue(ok),
    performNextChunk: jest.fn().mockReturnValue(ok),
    performPrevChunk: jest.fn().mockReturnValue(ok),
  } as unknown as HyperPage;
}

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

describe("action-cache perform helper dispatch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("validates known page action methods", () => {
    expect(isPageActionMethod("click")).toBe(true);
    expect(isPageActionMethod("not-a-method")).toBe(false);
  });

  it("normalizes page action methods case-insensitively", () => {
    expect(normalizePageActionMethod(" CLICK ")).toBe("click");
    expect(normalizePageActionMethod("SelectOptionFromDropdown")).toBe(
      "selectOptionFromDropdown"
    );
    expect(normalizePageActionMethod("unknown")).toBeNull();
  });

  it("dispatches fill with value argument", async () => {
    const page = createMockHyperPage();
    const options = { maxSteps: 2 };

    await dispatchPerformHelper(page, "fill", "//input[1]", "hello", options);

    expect(page.performFill).toHaveBeenCalledWith("//input[1]", "hello", {
      maxSteps: 2,
    });
  });

  it("dispatches click without value argument", async () => {
    const page = createMockHyperPage();
    const options = { maxSteps: 1 };

    await dispatchPerformHelper(page, "click", "//button[1]", undefined, options);

    expect(page.performClick).toHaveBeenCalledWith("//button[1]", {
      maxSteps: 1,
    });
  });

  it("trims whitespace performInstruction when attaching helpers", async () => {
    const agentDeps: AgentDeps = {
      llm: createMockLLM(),
      debug: false,
      tokenLimit: 1000,
      variables: [],
      cdpActionsEnabled: false,
    };
    const page = createMockHyperPage();
    attachCachedActionHelpers(agentDeps, page);

    await page.performClick("//button[1]", {
      performInstruction: "   ",
    });

    expect(runCachedStep).toHaveBeenCalledWith(
      expect.objectContaining({
        instruction: "Click element",
      })
    );
  });

  it("throws readable error when helper access traps throw", async () => {
    const page = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "performClick") {
            throw new Error("helper getter trap");
          }
          return undefined;
        },
      }
    ) as unknown as HyperPage;

    await expect(
      dispatchPerformHelper(page, "click", "//button[1]", undefined, {})
    ).rejects.toThrow(
      "[Replay] Failed to access performClick: helper getter trap"
    );
  });

  it("truncates oversized helper access diagnostics", async () => {
    const page = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "performClick") {
            throw new Error(`x${"y".repeat(2_000)}\nhelper getter trap`);
          }
          return undefined;
        },
      }
    ) as unknown as HyperPage;

    await expect(
      dispatchPerformHelper(page, "click", "//button[1]", undefined, {})
    ).rejects.toThrow(/\[truncated/);
  });

  it("throws readable error when helper method is missing", async () => {
    const page = {} as unknown as HyperPage;

    await expect(
      dispatchPerformHelper(page, "click", "//button[1]", undefined, {})
    ).rejects.toThrow("[Replay] Missing perform helper: performClick");
  });

  it("truncates oversized helper pre-execution diagnostics", async () => {
    const page = {
      performClick: (): never => {
        throw new Error(`x${"y".repeat(2_000)}\nhelper execution trap`);
      },
    } as unknown as HyperPage;

    await expect(
      dispatchPerformHelper(page, "click", "//button[1]", undefined, {})
    ).rejects.toThrow(/\[truncated/);
  });

  it("normalizes trap-prone options and large args when attaching helpers", async () => {
    const agentDeps: AgentDeps = {
      llm: createMockLLM(),
      debug: false,
      tokenLimit: 1000,
      variables: [],
      cdpActionsEnabled: false,
    };
    const page = createMockHyperPage();
    attachCachedActionHelpers(agentDeps, page);
    const trappedOptions = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (
            prop === "performInstruction" ||
            prop === "maxSteps" ||
            prop === "frameIndex"
          ) {
            throw new Error("options trap");
          }
          return undefined;
        },
      }
    );
    const huge = "x".repeat(25_000);

    await page.performType("//input[1]", huge, trappedOptions as never);

    expect(runCachedStep).toHaveBeenCalledWith(
      expect.objectContaining({
        instruction: "Type text",
        maxSteps: 3,
        cachedAction: expect.objectContaining({
          frameIndex: 0,
          arguments: [expect.stringMatching(/^x+$/)],
        }),
      })
    );
    const cachedAction = (
      runCachedStep.mock.calls[0]?.[0] as {
        cachedAction?: { arguments?: string[] };
      }
    ).cachedAction;
    expect(cachedAction?.arguments?.[0]?.length).toBe(20_000);
  });

  it("caps oversized maxSteps passed to attached perform helpers", async () => {
    const agentDeps: AgentDeps = {
      llm: createMockLLM(),
      debug: false,
      tokenLimit: 1000,
      variables: [],
      cdpActionsEnabled: false,
    };
    const page = createMockHyperPage();
    attachCachedActionHelpers(agentDeps, page);

    await page.performClick("//button[1]", {
      maxSteps: 999,
    });

    expect(runCachedStep).toHaveBeenCalledWith(
      expect.objectContaining({
        maxSteps: 20,
      })
    );
  });

  it("caps oversized frameIndex passed to attached perform helpers", async () => {
    const agentDeps: AgentDeps = {
      llm: createMockLLM(),
      debug: false,
      tokenLimit: 1000,
      variables: [],
      cdpActionsEnabled: false,
    };
    const page = createMockHyperPage();
    attachCachedActionHelpers(agentDeps, page);

    await page.performClick("//button[1]", {
      frameIndex: 50_000,
      maxSteps: 2,
    });

    expect(runCachedStep).toHaveBeenCalledWith(
      expect.objectContaining({
        cachedAction: expect.objectContaining({
          frameIndex: 1_000,
        }),
      })
    );
  });

  it("sanitizes control characters in perform options and text arguments", async () => {
    const agentDeps: AgentDeps = {
      llm: createMockLLM(),
      debug: false,
      tokenLimit: 1000,
      variables: [],
      cdpActionsEnabled: false,
    };
    const page = createMockHyperPage();
    attachCachedActionHelpers(agentDeps, page);

    await page.performType("//input[\u0000 1]", "ab\u0000\ncd", {
      performInstruction: "  custom\u0000\n instruction  ",
      maxSteps: 2,
    });

    expect(runCachedStep).toHaveBeenCalledWith(
      expect.objectContaining({
        instruction: "custom instruction",
        cachedAction: expect.objectContaining({
          xpath: expect.stringContaining("//input["),
          arguments: ["ab  cd"],
        }),
      })
    );
    const cachedAction = (
      runCachedStep.mock.calls[0]?.[0] as {
        cachedAction?: { xpath?: string };
      }
    ).cachedAction;
    expect(cachedAction?.xpath).not.toContain("\u0000");
  });

  it("forwards filterAdTrackingFrames override from helper options", async () => {
    const agentDeps: AgentDeps = {
      llm: createMockLLM(),
      debug: false,
      tokenLimit: 1000,
      variables: [],
      cdpActionsEnabled: false,
      filterAdTrackingFrames: true,
    };
    const page = createMockHyperPage();
    attachCachedActionHelpers(agentDeps, page);

    await page.performClick("//button[1]", {
      filterAdTrackingFrames: false,
    });

    expect(runCachedStep).toHaveBeenCalledWith(
      expect.objectContaining({
        filterAdTrackingFrames: false,
      })
    );
  });

  it("forwards cdpActions override from helper options", async () => {
    const agentDeps: AgentDeps = {
      llm: createMockLLM(),
      debug: false,
      tokenLimit: 1000,
      variables: [],
      cdpActionsEnabled: false,
      filterAdTrackingFrames: true,
    };
    const page = createMockHyperPage();
    attachCachedActionHelpers(agentDeps, page);

    await page.performClick("//button[1]", {
      cdpActions: true,
    });

    expect(runCachedStep).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpActionsEnabled: true,
      })
    );
  });

  it("falls back to agent defaults when helper options getters trap", async () => {
    const agentDeps: AgentDeps = {
      llm: createMockLLM(),
      debug: false,
      tokenLimit: 1000,
      variables: [],
      cdpActionsEnabled: false,
      filterAdTrackingFrames: false,
    };
    const page = createMockHyperPage();
    attachCachedActionHelpers(agentDeps, page);

    const trappedOptions = new Proxy(
      {},
      {
        get: (_target, prop: string | symbol) => {
          if (prop === "cdpActions" || prop === "filterAdTrackingFrames") {
            throw new Error("helper option trap");
          }
          return undefined;
        },
      }
    ) as PerformOptions;

    await page.performClick("//button[1]", trappedOptions);

    expect(runCachedStep).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpActionsEnabled: false,
        filterAdTrackingFrames: false,
      })
    );
  });

  it("uses default maxSteps when helper options maxSteps getter traps", async () => {
    const agentDeps: AgentDeps = {
      llm: createMockLLM(),
      debug: false,
      tokenLimit: 1000,
      variables: [],
      cdpActionsEnabled: false,
      filterAdTrackingFrames: true,
    };
    const page = createMockHyperPage();
    attachCachedActionHelpers(agentDeps, page);

    const trappedOptions = new Proxy(
      {},
      {
        get: (_target, prop: string | symbol) => {
          if (prop === "maxSteps") {
            throw new Error("maxSteps trap");
          }
          return undefined;
        },
      }
    ) as PerformOptions;

    await page.performClick("//button[1]", trappedOptions);

    expect(runCachedStep).toHaveBeenCalledWith(
      expect.objectContaining({
        maxSteps: 3,
      })
    );
  });
});
