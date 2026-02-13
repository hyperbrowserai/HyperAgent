import { HyperAgent } from "@/agent";
import { TaskStatus, type ActionCacheOutput } from "@/types/agent/types";
import type { HyperAgentLLM } from "@/llm/types";

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

describe("runFromActionCache hardening", () => {
  it("falls back to instruction perform when helper method cache lacks xpath", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    const perform = jest.fn().mockResolvedValue({
      taskId: "perform-task",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "performed via instruction",
      replayStepMeta: {
        usedCachedAction: false,
        fallbackUsed: true,
        retries: 1,
        cachedXPath: null,
        fallbackXPath: "/html/body/button[1]",
        fallbackElementId: "0-1",
      },
    });
    const performClick = jest.fn();

    const page = {
      perform,
      performClick,
    } as unknown as import("@/types/agent/types").HyperPage;

    const cache: ActionCacheOutput = {
      taskId: "cache-task",
      createdAt: new Date().toISOString(),
      status: TaskStatus.COMPLETED,
      steps: [
        {
          stepIndex: 0,
          instruction: "click login",
          elementId: "0-1",
          method: "click",
          arguments: [],
          frameIndex: 0,
          xpath: null,
          actionType: "actElement",
          success: true,
          message: "cached",
        },
      ],
    };

    const replay = await agent.runFromActionCache(cache, page);

    expect(perform).toHaveBeenCalledWith("click login");
    expect(performClick).not.toHaveBeenCalled();
    expect(replay.status).toBe(TaskStatus.COMPLETED);
    expect(replay.steps[0]?.usedXPath).toBe(false);
  });

  it("fails fast when method cache lacks both xpath and instruction", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    const page = {} as import("@/types/agent/types").HyperPage;
    const cache: ActionCacheOutput = {
      taskId: "cache-task",
      createdAt: new Date().toISOString(),
      status: TaskStatus.COMPLETED,
      steps: [
        {
          stepIndex: 0,
          instruction: undefined,
          elementId: "0-1",
          method: "click",
          arguments: [],
          frameIndex: 0,
          xpath: null,
          actionType: "actElement",
          success: true,
          message: "cached",
        },
      ],
    };

    const replay = await agent.runFromActionCache(cache, page);

    expect(replay.status).toBe(TaskStatus.FAILED);
    expect(replay.steps[0]?.message).toContain("without XPath or instruction");
  });

  it("replays special wait action using actionParams duration", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    const waitForTimeout = jest.fn().mockResolvedValue(undefined);
    const page = {
      waitForTimeout,
    } as unknown as import("@/types/agent/types").HyperPage;
    const cache: ActionCacheOutput = {
      taskId: "cache-task",
      createdAt: new Date().toISOString(),
      status: TaskStatus.COMPLETED,
      steps: [
        {
          stepIndex: 0,
          instruction: "wait before next action",
          elementId: null,
          method: null,
          arguments: [],
          actionParams: { duration: "750" },
          frameIndex: null,
          xpath: null,
          actionType: "wait",
          success: true,
          message: "cached",
        },
      ],
    };

    const replay = await agent.runFromActionCache(cache, page);

    expect(waitForTimeout).toHaveBeenCalledWith(750);
    expect(replay.status).toBe(TaskStatus.COMPLETED);
    expect(replay.steps[0]?.success).toBe(true);
    expect(replay.steps[0]?.message).toContain("Waited 750ms");
  });
});
