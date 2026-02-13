import { HyperAgent } from "@/agent";
import { TaskStatus, type ActionCacheOutput } from "@/types/agent/types";
import type { HyperAgentLLM } from "@/llm/types";
import fs from "fs";

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
    expect(replay.steps[0]?.retries).toBe(1);
  });

  it("fails replay step cleanly when special action execution throws", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    const waitForTimeout = jest
      .fn()
      .mockRejectedValue(new Error("timeout call failed"));
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
          actionParams: { duration: 100 },
          frameIndex: null,
          xpath: null,
          actionType: "wait",
          success: true,
          message: "cached",
        },
      ],
    };

    const replay = await agent.runFromActionCache(cache, page);

    expect(replay.status).toBe(TaskStatus.FAILED);
    expect(replay.steps[0]?.message).toContain("Replay step 0 failed");
    expect(replay.steps[0]?.message).toContain("timeout call failed");
    expect(replay.steps[0]?.usedXPath).toBe(true);
  });

  it("fails replay step cleanly when helper dispatch throws", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    const performClick = jest
      .fn()
      .mockRejectedValue(new Error("helper click failed"));
    const page = {
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
          xpath: "//button[1]",
          actionType: "actElement",
          success: true,
          message: "cached",
        },
      ],
    };

    const replay = await agent.runFromActionCache(cache, page);

    expect(replay.status).toBe(TaskStatus.FAILED);
    expect(replay.steps[0]?.message).toContain("Replay step 0 failed");
    expect(replay.steps[0]?.message).toContain("helper click failed");
    expect(replay.steps[0]?.usedXPath).toBe(true);
  });

  it("does not fail replay when debug file write throws", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
      debug: true,
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
          instruction: "wait",
          elementId: null,
          method: null,
          arguments: [],
          actionParams: { duration: 10 },
          frameIndex: null,
          xpath: null,
          actionType: "wait",
          success: true,
          message: "cached",
        },
      ],
    };
    const writeSpy = jest
      .spyOn(fs, "writeFileSync")
      .mockImplementation(() => {
        throw new Error("disk full");
      });
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      const replay = await agent.runFromActionCache(cache, page, { debug: true });

      expect(replay.status).toBe(TaskStatus.COMPLETED);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
