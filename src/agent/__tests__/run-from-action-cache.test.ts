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

  it("trims cached helper method and xpath before dispatch", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    const performClick = jest.fn().mockResolvedValue({
      taskId: "click-task",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "clicked via helper",
      replayStepMeta: {
        usedCachedAction: true,
        fallbackUsed: false,
        retries: 1,
      },
    });
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
          instruction: "  click login  ",
          elementId: "0-1",
          method: " CLICK ",
          arguments: [],
          frameIndex: 0,
          xpath: "  //button[1]  ",
          actionType: "actElement",
          success: true,
          message: "cached",
        },
      ],
    };

    const replay = await agent.runFromActionCache(cache, page);

    expect(performClick).toHaveBeenCalledWith(
      "//button[1]",
      expect.objectContaining({
        performInstruction: "click login",
      })
    );
    expect(replay.status).toBe(TaskStatus.COMPLETED);
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

  it("treats whitespace instruction as missing when xpath is unavailable", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    const perform = jest.fn();
    const page = {
      perform,
    } as unknown as import("@/types/agent/types").HyperPage;
    const cache: ActionCacheOutput = {
      taskId: "cache-task",
      createdAt: new Date().toISOString(),
      status: TaskStatus.COMPLETED,
      steps: [
        {
          stepIndex: 0,
          instruction: "   ",
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
    expect(perform).not.toHaveBeenCalled();
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

  it("does not mark cached XPath usage when perform fallback path throws", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    const perform = jest.fn().mockRejectedValue(new Error("perform failed"));
    const page = {
      perform,
    } as unknown as import("@/types/agent/types").HyperPage;
    const cache: ActionCacheOutput = {
      taskId: "cache-task",
      createdAt: new Date().toISOString(),
      status: TaskStatus.COMPLETED,
      steps: [
        {
          stepIndex: 0,
          instruction: "try fallback perform",
          elementId: null,
          method: null,
          arguments: [],
          frameIndex: null,
          xpath: null,
          actionType: "unknown-action",
          success: true,
          message: "cached",
        },
      ],
    };

    const replay = await agent.runFromActionCache(cache, page);

    expect(replay.status).toBe(TaskStatus.FAILED);
    expect(replay.steps[0]?.message).toContain("perform failed");
    expect(replay.steps[0]?.usedXPath).toBe(false);
  });

  it("serializes non-Error replay failures from perform path", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    const perform = jest.fn().mockRejectedValue({ reason: "perform exploded" });
    const page = {
      perform,
    } as unknown as import("@/types/agent/types").HyperPage;
    const cache: ActionCacheOutput = {
      taskId: "cache-task",
      createdAt: new Date().toISOString(),
      status: TaskStatus.COMPLETED,
      steps: [
        {
          stepIndex: 0,
          instruction: "trigger perform",
          elementId: null,
          method: null,
          arguments: [],
          frameIndex: null,
          xpath: null,
          actionType: "unknown-action",
          success: true,
          message: "cached",
        },
      ],
    };

    const replay = await agent.runFromActionCache(cache, page);

    expect(replay.status).toBe(TaskStatus.FAILED);
    expect(replay.steps[0]?.message).toContain(
      'Replay step 0 failed: {"reason":"perform exploded"}'
    );
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

  it("preserves empty replay output messages instead of replacing them", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    const perform = jest.fn().mockResolvedValue({
      taskId: "perform-task",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "",
      replayStepMeta: {
        usedCachedAction: false,
        fallbackUsed: false,
        retries: 1,
      },
    });
    const page = {
      perform,
    } as unknown as import("@/types/agent/types").HyperPage;
    const cache: ActionCacheOutput = {
      taskId: "cache-task",
      createdAt: new Date().toISOString(),
      status: TaskStatus.COMPLETED,
      steps: [
        {
          stepIndex: 0,
          instruction: "empty output path",
          elementId: null,
          method: null,
          arguments: [],
          frameIndex: null,
          xpath: null,
          actionType: "unknown-action",
          success: true,
          message: "cached",
        },
      ],
    };

    const replay = await agent.runFromActionCache(cache, page);

    expect(replay.status).toBe(TaskStatus.COMPLETED);
    expect(replay.steps[0]?.message).toBe("");
  });

  it("handles malformed non-finite step indices safely", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    const perform = jest
      .fn()
      .mockResolvedValue({
        taskId: "perform-task-1",
        status: TaskStatus.COMPLETED,
        steps: [],
        output: "first",
      })
      .mockResolvedValueOnce({
        taskId: "perform-task-0",
        status: TaskStatus.COMPLETED,
        steps: [],
        output: "second",
      });
    const page = {
      perform,
    } as unknown as import("@/types/agent/types").HyperPage;
    const cache: ActionCacheOutput = {
      taskId: "cache-task",
      createdAt: new Date().toISOString(),
      status: TaskStatus.COMPLETED,
      steps: [
        {
          stepIndex: Number.NaN,
          instruction: "nan index step",
          elementId: null,
          method: null,
          arguments: [],
          frameIndex: null,
          xpath: null,
          actionType: "unknown-action",
          success: true,
          message: "cached",
        },
        {
          stepIndex: 0,
          instruction: "normal step",
          elementId: null,
          method: null,
          arguments: [],
          frameIndex: null,
          xpath: null,
          actionType: "unknown-action",
          success: true,
          message: "cached",
        },
      ],
    };

    const replay = await agent.runFromActionCache(cache, page);

    expect(replay.status).toBe(TaskStatus.COMPLETED);
    expect(perform).toHaveBeenNthCalledWith(1, "normal step");
    expect(perform).toHaveBeenNthCalledWith(2, "nan index step");
    expect(replay.steps[0]?.stepIndex).toBe(0);
    expect(replay.steps[1]?.stepIndex).toBe(-1);
  });
});
