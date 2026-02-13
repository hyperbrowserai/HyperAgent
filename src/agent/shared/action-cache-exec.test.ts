import {
  attachCachedActionHelpers,
  dispatchPerformHelper,
  isPageActionMethod,
  normalizePageActionMethod,
} from "@/agent/shared/action-cache-exec";
import type { AgentDeps, HyperPage } from "@/types/agent/types";
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
});
