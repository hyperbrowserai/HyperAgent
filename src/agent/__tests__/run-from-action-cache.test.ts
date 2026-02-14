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

  it("sanitizes oversized replay action types in failure output", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    const page = {} as import("@/types/agent/types").HyperPage;
    const oversizedActionType = `action-${"x".repeat(500)}\nunsafe`;
    const cache: ActionCacheOutput = {
      taskId: "cache-task",
      createdAt: new Date().toISOString(),
      status: TaskStatus.COMPLETED,
      steps: [
        {
          stepIndex: 0,
          instruction: undefined,
          elementId: null,
          method: null,
          arguments: [],
          frameIndex: null,
          xpath: null,
          actionType: oversizedActionType,
          success: true,
          message: "cached",
        },
      ],
    };

    const replay = await agent.runFromActionCache(cache, page);

    expect(replay.status).toBe(TaskStatus.FAILED);
    expect(replay.steps[0]?.actionType).toContain("[truncated");
    expect(replay.steps[0]?.actionType).not.toContain("\n");
    expect(replay.steps[0]?.message).toContain("[truncated");
    expect(replay.steps[0]?.message).not.toContain("\n");
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

  it("replays special waitForLoadState action", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    const waitForLoadState = jest.fn().mockResolvedValue(undefined);
    const page = {
      waitForLoadState,
    } as unknown as import("@/types/agent/types").HyperPage;
    const cache: ActionCacheOutput = {
      taskId: "cache-task",
      createdAt: new Date().toISOString(),
      status: TaskStatus.COMPLETED,
      steps: [
        {
          stepIndex: 0,
          instruction: "wait loadstate",
          elementId: null,
          method: null,
          arguments: ["NETWORKIDLE", "1200"],
          frameIndex: null,
          xpath: null,
          actionType: "waitForLoadState",
          success: true,
          message: "cached",
        },
      ],
    };

    const replay = await agent.runFromActionCache(cache, page);

    expect(waitForLoadState).toHaveBeenCalledWith("networkidle", {
      timeout: 1200,
    });
    expect(replay.status).toBe(TaskStatus.COMPLETED);
    expect(replay.steps[0]?.message).toContain("Waited for load state: networkidle");
  });

  it("stops replay side-effects after closeAgent is called mid-run", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    let resolveWait!: () => void;
    const waitForTimeout = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWait = resolve;
        })
    );
    const performClick = jest.fn().mockResolvedValue({
      taskId: "click-task",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "clicked",
      replayStepMeta: {
        usedCachedAction: true,
        fallbackUsed: false,
        retries: 1,
      },
    });
    const page = {
      waitForTimeout,
      performClick,
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
          message: "cached wait",
        },
        {
          stepIndex: 1,
          instruction: "click submit",
          elementId: "0-1",
          method: "click",
          arguments: [],
          frameIndex: 0,
          xpath: "//button[1]",
          actionType: "actElement",
          success: true,
          message: "cached click",
        },
      ],
    };

    const replayPromise = agent.runFromActionCache(cache, page);
    expect(waitForTimeout).toHaveBeenCalledTimes(1);
    await expect(agent.closeAgent()).resolves.toBeUndefined();
    resolveWait();

    const replay = await replayPromise;

    expect(replay.status).toBe(TaskStatus.FAILED);
    expect(performClick).not.toHaveBeenCalled();
    expect(replay.steps[1]?.message).toBe(
      "Replay stopped because agent was closed"
    );
  });

  it("skips replay debug artifact writes after closeAgent generation changes", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
      debug: true,
    });
    let resolveWait!: () => void;
    const waitForTimeout = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWait = resolve;
        })
    );
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
          message: "cached wait",
        },
        {
          stepIndex: 1,
          instruction: "wait again",
          elementId: null,
          method: null,
          arguments: [],
          actionParams: { duration: 10 },
          frameIndex: null,
          xpath: null,
          actionType: "wait",
          success: true,
          message: "cached wait 2",
        },
      ],
    };
    const writeSpy = jest.spyOn(fs, "writeFileSync").mockImplementation(() => {
      return undefined;
    });

    try {
      const replayPromise = agent.runFromActionCache(cache, page, { debug: true });
      await expect(agent.closeAgent()).resolves.toBeUndefined();
      resolveWait();

      const replay = await replayPromise;
      expect(replay.status).toBe(TaskStatus.FAILED);
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("prioritizes shutdown-stop diagnostics over replay-limit diagnostics", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    let resolveWait!: () => void;
    const waitForTimeout = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWait = resolve;
        })
    );
    const perform = jest.fn();
    const page = {
      waitForTimeout,
      perform,
    } as unknown as import("@/types/agent/types").HyperPage;
    const maxReplaySteps = (
      HyperAgent as unknown as { MAX_REPLAY_STEPS: number }
    ).MAX_REPLAY_STEPS;
    const steps: ActionCacheOutput["steps"] = [
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
        message: "cached wait",
      },
      ...Array.from({ length: maxReplaySteps + 5 }, (_, index) => ({
        stepIndex: index + 1,
        instruction: `step ${index + 1}`,
        elementId: null,
        method: null,
        arguments: [],
        frameIndex: null,
        xpath: null,
        actionType: "unknown-action",
        success: true,
        message: "cached",
      })),
    ];
    const cache: ActionCacheOutput = {
      taskId: "cache-task",
      createdAt: new Date().toISOString(),
      status: TaskStatus.COMPLETED,
      steps,
    };

    const replayPromise = agent.runFromActionCache(cache, page);
    await expect(agent.closeAgent()).resolves.toBeUndefined();
    resolveWait();

    const replay = await replayPromise;
    expect(replay.status).toBe(TaskStatus.FAILED);
    expect(perform).not.toHaveBeenCalled();
    expect(replay.steps.some((step) => step.actionType === "replay-limit")).toBe(
      false
    );
    expect(replay.steps[replay.steps.length - 1]?.message).toBe(
      "Replay stopped because agent was closed"
    );
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

  it("truncates oversized replay debug write diagnostics", async () => {
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
        throw new Error("x".repeat(2_000));
      });
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      const replay = await agent.runFromActionCache(cache, page, { debug: true });

      expect(replay.status).toBe(TaskStatus.COMPLETED);
      const firstMessage = String(errorSpy.mock.calls[0]?.[0] ?? "");
      expect(firstMessage).toContain("[truncated");
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

  it("sanitizes replay output control characters", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    const perform = jest.fn().mockResolvedValue({
      taskId: "perform-task",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "line-1\nline-2\u0007",
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
          instruction: "sanitize output",
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
    expect(replay.steps[0]?.message).toBe("line-1 line-2");
  });

  it("formats non-string replay outputs into readable diagnostics", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    const perform = jest.fn().mockResolvedValue({
      taskId: "perform-task",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: { reason: "object output" } as unknown as string,
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
          instruction: "non string output path",
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
    expect(replay.steps[0]?.message).toBe('{"reason":"object output"}');
  });

  it("handles trap-prone replay step metadata without failing replay", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    const perform = jest.fn().mockResolvedValue({
      get status(): TaskStatus {
        return TaskStatus.COMPLETED;
      },
      get output(): string {
        return "done";
      },
      get replayStepMeta(): never {
        throw new Error("meta trap");
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
          instruction: "meta trap path",
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
    expect(replay.steps[0]).toMatchObject({
      success: true,
      usedXPath: false,
      fallbackUsed: false,
      retries: 0,
      message: "done",
    });
  });

  it("fails replay step deterministically when replay result status/output getters trap", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    const perform = jest.fn().mockResolvedValue({
      get status(): never {
        throw new Error("status trap");
      },
      get output(): never {
        throw new Error("output trap");
      },
      replayStepMeta: {
        usedCachedAction: true,
        fallbackUsed: false,
        retries: 2,
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
          instruction: "status trap path",
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
    expect(replay.steps[0]).toMatchObject({
      success: false,
      usedXPath: true,
      retries: 2,
      message: "Failed to execute cached action",
    });
  });

  it("truncates oversized replay output diagnostics", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    const perform = jest.fn().mockResolvedValue({
      taskId: "perform-task",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "x".repeat(9_000),
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
          instruction: "oversized output path",
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
    const message = replay.steps[0]?.message ?? "";

    expect(message).toContain("[truncated");
    expect(message.length).toBeLessThanOrEqual(4_100);
  });

  it("truncates oversized replay step lists to bounded limits", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    const perform = jest.fn().mockResolvedValue({
      taskId: "perform-task",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "ok",
      replayStepMeta: {
        usedCachedAction: false,
        fallbackUsed: false,
        retries: 1,
      },
    });
    const page = {
      perform,
    } as unknown as import("@/types/agent/types").HyperPage;
    const maxReplaySteps = (
      HyperAgent as unknown as { MAX_REPLAY_STEPS: number }
    ).MAX_REPLAY_STEPS;
    const cache: ActionCacheOutput = {
      taskId: "cache-task",
      createdAt: new Date().toISOString(),
      status: TaskStatus.COMPLETED,
      steps: Array.from({ length: maxReplaySteps + 1 }, (_, index) => ({
        stepIndex: index,
        instruction: `step ${index}`,
        elementId: null,
        method: null,
        arguments: [],
        frameIndex: null,
        xpath: null,
        actionType: "unknown-action",
        success: true,
        message: "cached",
      })),
    };

    const replay = await agent.runFromActionCache(cache, page);

    expect(perform).toHaveBeenCalledTimes(maxReplaySteps);
    expect(replay.status).toBe(TaskStatus.FAILED);
    const finalStep = replay.steps[replay.steps.length - 1];
    expect(finalStep?.actionType).toBe("replay-limit");
    expect(finalStep?.message).toContain("Replay truncated after");
  });

  it("reports lower-bound replay truncation for oversized iterable step sources", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    const perform = jest.fn().mockResolvedValue({
      taskId: "perform-task",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "ok",
      replayStepMeta: {
        usedCachedAction: false,
        fallbackUsed: false,
        retries: 1,
      },
    });
    const page = {
      perform,
    } as unknown as import("@/types/agent/types").HyperPage;
    const maxReplaySteps = (
      HyperAgent as unknown as { MAX_REPLAY_STEPS: number }
    ).MAX_REPLAY_STEPS;
    const iterableSteps = {
      *[Symbol.iterator](): IterableIterator<{
        stepIndex: number;
        instruction: string;
        elementId: null;
        method: null;
        arguments: [];
        frameIndex: null;
        xpath: null;
        actionType: string;
        success: true;
        message: string;
      }> {
        for (let index = 0; index < maxReplaySteps + 50; index += 1) {
          yield {
            stepIndex: index,
            instruction: `iterable-step-${index}`,
            elementId: null,
            method: null,
            arguments: [],
            frameIndex: null,
            xpath: null,
            actionType: "unknown-action",
            success: true,
            message: "cached",
          };
        }
      },
    };
    const cache = {
      taskId: "cache-task",
      createdAt: new Date().toISOString(),
      status: TaskStatus.COMPLETED,
      steps: iterableSteps,
    } as unknown as ActionCacheOutput;

    const replay = await agent.runFromActionCache(cache, page);

    expect(perform).toHaveBeenCalledTimes(maxReplaySteps);
    expect(replay.status).toBe(TaskStatus.FAILED);
    const finalStep = replay.steps[replay.steps.length - 1];
    expect(finalStep?.actionType).toBe("replay-limit");
    expect(finalStep?.message).toContain("at least");
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

  it("fails gracefully when cached steps are unreadable", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    const page = {} as import("@/types/agent/types").HyperPage;
    const cache = {
      taskId: "cache-task",
      createdAt: new Date().toISOString(),
      status: TaskStatus.COMPLETED,
      get steps(): unknown[] {
        throw new Error("steps trap");
      },
    } as unknown as ActionCacheOutput;

    const replay = await agent.runFromActionCache(cache, page);

    expect(replay.status).toBe(TaskStatus.FAILED);
    expect(replay.steps[0]?.message).toContain("Failed to read cached steps");
    expect(replay.steps[0]?.message).toContain("steps trap");
  });

  it("falls back to unknown source task id when cache taskId getter traps", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    const perform = jest.fn().mockResolvedValue({
      taskId: "perform-task",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "performed",
      replayStepMeta: {
        usedCachedAction: false,
        fallbackUsed: false,
        retries: 1,
      },
    });
    const page = {
      perform,
    } as unknown as import("@/types/agent/types").HyperPage;
    const cache = {
      get taskId(): string {
        throw new Error("taskId trap");
      },
      createdAt: new Date().toISOString(),
      status: TaskStatus.COMPLETED,
      steps: [
        {
          stepIndex: 0,
          instruction: "fallback source id",
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
    } as unknown as ActionCacheOutput;

    const replay = await agent.runFromActionCache(cache, page);

    expect(replay.sourceTaskId).toBe("unknown-task");
    expect(replay.status).toBe(TaskStatus.COMPLETED);
    expect(perform).toHaveBeenCalledWith("fallback source id");
  });

  it("truncates oversized cached-step read diagnostics", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    const page = {} as import("@/types/agent/types").HyperPage;
    const cache = {
      taskId: "cache-task",
      createdAt: new Date().toISOString(),
      status: TaskStatus.COMPLETED,
      get steps(): unknown[] {
        throw new Error("x".repeat(2_000));
      },
    } as unknown as ActionCacheOutput;

    const replay = await agent.runFromActionCache(cache, page);

    expect(replay.status).toBe(TaskStatus.FAILED);
    expect(replay.steps[0]?.message).toContain("Failed to read cached steps");
    expect(replay.steps[0]?.message).toContain("[truncated");
  });

  it("sanitizes control characters in cached-step read diagnostics", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    const page = {} as import("@/types/agent/types").HyperPage;
    const cache = {
      taskId: "cache-task",
      createdAt: new Date().toISOString(),
      status: TaskStatus.COMPLETED,
      get steps(): unknown[] {
        throw new Error(`steps\u0000\n${"x".repeat(2_000)}`);
      },
    } as unknown as ActionCacheOutput;

    const replay = await agent.runFromActionCache(cache, page);

    expect(replay.status).toBe(TaskStatus.FAILED);
    const message = replay.steps[0]?.message ?? "";
    expect(message).toContain("Failed to read cached steps");
    expect(message).toContain("[truncated");
    expect(message).not.toContain("\u0000");
    expect(message).not.toContain("\n");
  });

  it("fails replay step cleanly when page getter throws", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
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

    const replay = await agent.runFromActionCache(cache, () => {
      throw new Error("page getter trap");
    });

    expect(replay.status).toBe(TaskStatus.FAILED);
    expect(replay.steps[0]?.message).toContain("page getter trap");
  });

  it("truncates oversized page-getter replay diagnostics", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
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

    const replay = await agent.runFromActionCache(cache, () => {
      throw new Error(`x${"y".repeat(2_000)}\npage getter trap`);
    });

    expect(replay.status).toBe(TaskStatus.FAILED);
    expect(replay.steps[0]?.message).toContain("[truncated");
    expect(replay.steps[0]?.message).not.toContain("\n");
  });

  it("truncates oversized perform-path replay diagnostics", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      cdpActions: false,
    });
    const perform = jest
      .fn()
      .mockRejectedValue(new Error(`x${"y".repeat(2_000)}\nperform failed`));
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
    expect(replay.steps[0]?.message).toContain("[truncated");
    expect(replay.steps[0]?.message).not.toContain("\n");
  });

  it("normalizes invalid maxXPathRetries to default replay retries", async () => {
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

    await agent.runFromActionCache(cache, page, {
      maxXPathRetries: 0,
    });

    expect(performClick).toHaveBeenCalledWith(
      "//button[1]",
      expect.objectContaining({
        maxSteps: 3,
      })
    );
  });

  it("falls back to default replay params when param getters trap", async () => {
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
    const trapParams = {
      get maxXPathRetries(): number {
        throw new Error("max retry getter trap");
      },
      get debug(): boolean {
        throw new Error("debug getter trap");
      },
    };

    const replay = await agent.runFromActionCache(
      cache,
      page,
      trapParams as unknown as import("@/types/agent/types").RunFromActionCacheParams
    );

    expect(replay.status).toBe(TaskStatus.COMPLETED);
    expect(performClick).toHaveBeenCalledWith(
      "//button[1]",
      expect.objectContaining({
        maxSteps: 3,
      })
    );
  });
});
