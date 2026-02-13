import { z } from "zod";
import type { Page } from "playwright-core";
import { HyperAgent } from "@/agent";
import { getDebugOptions, setDebugOptions } from "@/debug/options";
import type { AgentActionDefinition, TaskParams, TaskState } from "@/types";
import type { HyperAgentLLM } from "@/llm/types";
import { runAgentTask } from "@/agent/tools/agent";
import { TaskStatus, type AgentTaskOutput } from "@/types/agent/types";
import { HyperagentError, HyperagentTaskError } from "@/agent/error";
import type { ActionCacheEntry } from "@/types/agent/types";

jest.mock("@/agent/tools/agent", () => ({
  runAgentTask: jest.fn(),
}));

function createMockLLM(): HyperAgentLLM {
  return {
    invoke: async () => ({
      role: "assistant",
      content: "ok",
    }),
    invokeStructured: async () => ({
      rawText: "{}",
      parsed: null,
    }),
    getProviderId: () => "mock",
    getModelId: () => "mock-model",
    getCapabilities: () => ({
      multimodal: false,
      toolCalling: true,
      jsonMode: true,
    }),
  };
}

describe("HyperAgent constructor and task controls", () => {
  beforeEach(() => {
    setDebugOptions(undefined, false);
    jest.clearAllMocks();
  });

  it("enables debug options when debug mode is true", () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: true,
      debugOptions: { traceWait: true },
    });

    expect(agent).toBeInstanceOf(HyperAgent);
    expect(getDebugOptions().enabled).toBe(true);
    expect(getDebugOptions().traceWait).toBe(true);
  });

  it("throws synchronously for reserved custom action names", () => {
    const reservedAction: AgentActionDefinition = {
      type: "complete",
      actionParams: z.object({}),
      run: async () => ({ success: true, message: "noop" }),
    };

    expect(
      () =>
        new HyperAgent({
          llm: createMockLLM(),
          customActions: [reservedAction],
        })
    ).toThrow("reserved action");
  });

  it("throws synchronously for duplicate custom action names", () => {
    const duplicateAction: AgentActionDefinition = {
      type: "goToUrl",
      actionParams: z.object({}),
      run: async () => ({ success: true, message: "noop" }),
    };

    expect(
      () =>
        new HyperAgent({
          llm: createMockLLM(),
          customActions: [duplicateAction],
        })
    ).toThrow("already registered");
  });

  it("returns async task controls with awaitable result promise", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    mockedRunAgentTask.mockResolvedValue({
      taskId: "task-id",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "done",
      actionCache: {
        taskId: "task-id",
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });

    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const fakePage = {} as unknown as Page;
    const task = await agent.executeTaskAsync("test task", undefined, fakePage);

    expect(task.id).toBeDefined();
    await expect(task.result).resolves.toMatchObject({
      status: TaskStatus.COMPLETED,
      output: "done",
    });
    const internalAgent = agent as unknown as {
      tasks: Record<string, unknown>;
      taskResults: Record<string, unknown>;
    };
    expect(Object.keys(internalAgent.tasks)).toHaveLength(0);
    expect(Object.keys(internalAgent.taskResults)).toHaveLength(0);
  });

  it("executeTaskAsync cleans up state when setup throws before run starts", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const on = jest.fn();
    const off = jest.fn();
    const internalAgent = agent as unknown as {
      context: {
        on: typeof on;
        off: typeof off;
      } | null;
      tasks: Record<string, unknown>;
      taskResults: Record<string, unknown>;
    };
    internalAgent.context = { on, off };

    const params = {} as TaskParams;
    Object.defineProperty(params, "outputSchema", {
      configurable: true,
      get: () => {
        throw new Error("output schema trap");
      },
    });

    const fakePage = {} as unknown as Page;
    await expect(agent.executeTaskAsync("test task", params, fakePage)).rejects
      .toThrow("output schema trap");
    expect(off).toHaveBeenCalledWith("page", expect.any(Function));
    expect(Object.keys(internalAgent.tasks)).toHaveLength(0);
    expect(Object.keys(internalAgent.taskResults)).toHaveLength(0);
  });

  it("executeTaskAsync cleans up state when runAgentTask throws synchronously", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    mockedRunAgentTask.mockImplementation(() => {
      throw new Error("sync run trap");
    });

    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const on = jest.fn();
    const off = jest.fn();
    const internalAgent = agent as unknown as {
      context: {
        on: typeof on;
        off: typeof off;
      } | null;
      tasks: Record<string, unknown>;
      taskResults: Record<string, unknown>;
    };
    internalAgent.context = { on, off };

    const fakePage = {} as unknown as Page;
    await expect(agent.executeTaskAsync("test task", undefined, fakePage)).rejects
      .toThrow("sync run trap");
    expect(off).toHaveBeenCalledWith("page", expect.any(Function));
    expect(Object.keys(internalAgent.tasks)).toHaveLength(0);
    expect(Object.keys(internalAgent.taskResults)).toHaveLength(0);
  });

  it("executeTaskAsync cleans up listener when task-state registration throws", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const on = jest.fn();
    const off = jest.fn();
    const internalAgent = agent as unknown as {
      context: {
        on: typeof on;
        off: typeof off;
      } | null;
      tasks: Record<string, unknown>;
    };
    internalAgent.context = { on, off };
    internalAgent.tasks = new Proxy(
      {},
      {
        set: () => {
          throw new Error("task register trap");
        },
      }
    );

    const fakePage = {} as unknown as Page;
    await expect(agent.executeTaskAsync("test task", undefined, fakePage)).rejects
      .toThrow("Failed to register task state");
    expect(off).toHaveBeenCalledWith("page", expect.any(Function));
  });

  it("executeTask cleans up listener when task-state registration throws", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const on = jest.fn();
    const off = jest.fn();
    const internalAgent = agent as unknown as {
      context: {
        on: typeof on;
        off: typeof off;
      } | null;
      tasks: Record<string, unknown>;
    };
    internalAgent.context = { on, off };
    internalAgent.tasks = new Proxy(
      {},
      {
        set: () => {
          throw new Error("task register trap");
        },
      }
    );

    const fakePage = {} as unknown as Page;
    await expect(agent.executeTask("test task", undefined, fakePage)).rejects.toThrow(
      "Failed to register task state"
    );
    expect(off).toHaveBeenCalledWith("page", expect.any(Function));
  });

  it("executeTaskAsync tolerates task-result promise assignment traps", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    mockedRunAgentTask.mockResolvedValue({
      taskId: "task-id",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "done",
      actionCache: {
        taskId: "task-id",
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });

    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: true,
    });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const internalAgent = agent as unknown as {
      taskResults: Record<string, Promise<AgentTaskOutput>>;
    };
    internalAgent.taskResults = new Proxy(
      {},
      {
        set: () => {
          throw new Error("task result set trap");
        },
      }
    ) as Record<string, Promise<AgentTaskOutput>>;

    const fakePage = {} as unknown as Page;
    try {
      const task = await agent.executeTaskAsync("test task", undefined, fakePage);
      await expect(task.result).resolves.toMatchObject({
        status: TaskStatus.COMPLETED,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to track task result promise")
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("emits and surfaces task-scoped errors from async execution", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    mockedRunAgentTask.mockRejectedValue(new Error("boom"));

    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const fakePage = {} as unknown as Page;
    const task = await agent.executeTaskAsync("test task", undefined, fakePage);
    const emittedErrorPromise = new Promise<Error>((resolve) => {
      task.emitter.once("error", resolve);
    });

    await expect(task.result).rejects.toBeInstanceOf(HyperagentTaskError);
    const emittedError = await emittedErrorPromise;

    expect(emittedError).toBeInstanceOf(HyperagentTaskError);
    expect((emittedError as HyperagentTaskError).taskId).toBe(task.id);
    expect((emittedError as HyperagentTaskError).cause.message).toBe("boom");
    const internalAgent = agent as unknown as {
      tasks: Record<string, unknown>;
      taskResults: Record<string, unknown>;
    };
    expect(Object.keys(internalAgent.tasks)).toHaveLength(0);
    expect(Object.keys(internalAgent.taskResults)).toHaveLength(0);
  });

  it("isolates task-scoped emitters across concurrent tasks", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    let resolveSecondTask!: (value: AgentTaskOutput) => void;
    mockedRunAgentTask.mockImplementation((_, state) => {
      if (state.task === "first task") {
        return Promise.reject(new Error("first task failure"));
      }
      return new Promise<AgentTaskOutput>((resolve) => {
        resolveSecondTask = resolve;
      });
    });

    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const fakePage = {} as unknown as Page;
    const firstTask = await agent.executeTaskAsync(
      "first task",
      undefined,
      fakePage
    );
    const secondTask = await agent.executeTaskAsync(
      "second task",
      undefined,
      fakePage
    );
    const secondErrorSpy = jest.fn();
    secondTask.emitter.on("error", secondErrorSpy);

    await expect(firstTask.result).rejects.toBeInstanceOf(HyperagentTaskError);
    expect(secondErrorSpy).not.toHaveBeenCalled();

    resolveSecondTask({
      taskId: secondTask.id,
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "done",
      actionCache: {
        taskId: secondTask.id,
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });
    await expect(secondTask.result).resolves.toMatchObject({
      status: TaskStatus.COMPLETED,
    });
  });

  it("removes task-scoped error forwarding listeners after task settles", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    let resolveTask!: (value: AgentTaskOutput) => void;
    mockedRunAgentTask.mockImplementation(
      () =>
        new Promise<AgentTaskOutput>((resolve) => {
          resolveTask = resolve;
        })
    );

    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      errorEmitter: { listenerCount: (event: string) => number };
    };
    const fakePage = {} as unknown as Page;
    const task = await agent.executeTaskAsync("listener cleanup", undefined, fakePage);
    expect(internalAgent.errorEmitter.listenerCount("error")).toBeGreaterThan(0);

    resolveTask({
      taskId: task.id,
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "done",
      actionCache: {
        taskId: task.id,
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });
    await expect(task.result).resolves.toMatchObject({
      status: TaskStatus.COMPLETED,
    });
    await Promise.resolve();
    expect(internalAgent.errorEmitter.listenerCount("error")).toBe(0);
  });

  it("closeAgent removes task-scoped error forwarders for in-flight tasks", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    mockedRunAgentTask.mockImplementation(
      () => new Promise<AgentTaskOutput>(() => undefined)
    );

    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      errorEmitter: { listenerCount: (event: string) => number };
    };
    const fakePage = {} as unknown as Page;
    await agent.executeTaskAsync("never settles", undefined, fakePage);
    expect(internalAgent.errorEmitter.listenerCount("error")).toBeGreaterThan(0);

    await expect(agent.closeAgent()).resolves.toBeUndefined();
    expect(internalAgent.errorEmitter.listenerCount("error")).toBe(0);
  });

  it("surfaces HyperagentTaskError without requiring error listeners", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    mockedRunAgentTask.mockRejectedValue(new Error("boom without listeners"));

    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const fakePage = {} as unknown as Page;
    const task = await agent.executeTaskAsync("test task", undefined, fakePage);

    await expect(task.result).rejects.toBeInstanceOf(HyperagentTaskError);
  });

  it("cancel does not override terminal failed task status", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    mockedRunAgentTask.mockRejectedValue(new Error("boom"));

    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const fakePage = {} as unknown as Page;
    const task = await agent.executeTaskAsync("test task", undefined, fakePage);

    await expect(task.result).rejects.toBeInstanceOf(HyperagentTaskError);
    expect(task.getStatus()).toBe(TaskStatus.FAILED);
    expect(task.cancel()).toBe(TaskStatus.FAILED);
    expect(task.getStatus()).toBe(TaskStatus.FAILED);
  });

  it("serializes non-Error async task failures with readable cause", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    mockedRunAgentTask.mockRejectedValue({ reason: "object boom" });

    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const fakePage = {} as unknown as Page;
    const task = await agent.executeTaskAsync("test task", undefined, fakePage);
    const emittedErrorPromise = new Promise<Error>((resolve) => {
      task.emitter.once("error", resolve);
    });

    await expect(task.result).rejects.toBeInstanceOf(HyperagentTaskError);
    const emittedError = await emittedErrorPromise;

    expect(emittedError).toBeInstanceOf(HyperagentTaskError);
    expect((emittedError as HyperagentTaskError).taskId).toBe(task.id);
    expect((emittedError as HyperagentTaskError).cause.message).toBe(
      '{"reason":"object boom"}'
    );
  });

  it("preserves cancelled status when async task rejects after cancel", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    let rejectTask!: (error: unknown) => void;
    mockedRunAgentTask.mockImplementation(
      () =>
        new Promise<AgentTaskOutput>((_, reject) => {
          rejectTask = reject;
        })
    );

    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const fakePage = {} as unknown as Page;
    const task = await agent.executeTaskAsync("cancel me", undefined, fakePage);
    const emitterSpy = jest.spyOn(task.emitter, "emit");

    expect(task.cancel()).toBe(TaskStatus.CANCELLED);
    rejectTask(new Error("async cancel rejection"));

    await expect(task.result).resolves.toMatchObject({
      status: TaskStatus.CANCELLED,
      output: "Task was cancelled",
      actionCache: { status: TaskStatus.CANCELLED },
    });
    expect(task.getStatus()).toBe(TaskStatus.CANCELLED);
    expect(emitterSpy).not.toHaveBeenCalledWith(
      "error",
      expect.any(HyperagentTaskError)
    );
  });

  it("preserves cancelled status when executeTask rejects after external cancellation", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    let rejectTask!: (error: unknown) => void;
    mockedRunAgentTask.mockImplementation(
      () =>
        new Promise<AgentTaskOutput>((_, reject) => {
          rejectTask = reject;
        })
    );

    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const fakePage = {} as unknown as Page;
    const execution = agent.executeTask("sync cancel", undefined, fakePage);
    const internalAgent = agent as unknown as {
      tasks: Record<string, TaskState>;
    };
    const activeTaskState = Object.values(internalAgent.tasks)[0];
    expect(activeTaskState).toBeDefined();
    activeTaskState.status = TaskStatus.CANCELLED;

    rejectTask(new Error("sync cancel rejection"));

    await expect(execution).resolves.toMatchObject({
      status: TaskStatus.CANCELLED,
      output: "Task was cancelled",
      actionCache: { status: TaskStatus.CANCELLED },
    });
    expect(activeTaskState.status).toBe(TaskStatus.CANCELLED);
  });

  it("returns cancelled output when async task resolves after manual cancel", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    let resolveTask!: (value: AgentTaskOutput) => void;
    mockedRunAgentTask.mockImplementation(
      () =>
        new Promise<AgentTaskOutput>((resolve) => {
          resolveTask = resolve;
        })
    );

    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const fakePage = {} as unknown as Page;
    const task = await agent.executeTaskAsync("cancel me", undefined, fakePage);

    expect(task.cancel()).toBe(TaskStatus.CANCELLED);
    resolveTask({
      taskId: task.id,
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "done",
      actionCache: {
        taskId: task.id,
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });

    await expect(task.result).resolves.toMatchObject({
      status: TaskStatus.CANCELLED,
      output: "Task was cancelled",
      actionCache: { status: TaskStatus.CANCELLED },
    });
  });

  it("returns cancelled output when sync task resolves after manual cancellation", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    let resolveTask!: (value: AgentTaskOutput) => void;
    mockedRunAgentTask.mockImplementation(
      () =>
        new Promise<AgentTaskOutput>((resolve) => {
          resolveTask = resolve;
        })
    );

    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const fakePage = {} as unknown as Page;
    const execution = agent.executeTask("sync cancel", undefined, fakePage);
    const internalAgent = agent as unknown as {
      tasks: Record<string, TaskState>;
    };
    const activeTaskState = Object.values(internalAgent.tasks)[0];
    expect(activeTaskState).toBeDefined();
    activeTaskState.status = TaskStatus.CANCELLED;

    resolveTask({
      taskId: "sync-cancel",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "done",
      actionCache: {
        taskId: "sync-cancel",
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });

    await expect(execution).resolves.toMatchObject({
      status: TaskStatus.CANCELLED,
      output: "Task was cancelled",
      actionCache: { status: TaskStatus.CANCELLED },
    });
  });

  it("cleans internal task state after synchronous executeTask completion", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    mockedRunAgentTask.mockResolvedValue({
      taskId: "task-id",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "done",
      actionCache: {
        taskId: "task-id",
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });

    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const fakePage = {} as unknown as Page;

    await agent.executeTask("sync task", undefined, fakePage);

    const internalAgent = agent as unknown as {
      tasks: Record<string, unknown>;
    };
    expect(Object.keys(internalAgent.tasks)).toHaveLength(0);
  });

  it("executeTaskAsync succeeds when action-cache assignment traps throw", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    mockedRunAgentTask.mockResolvedValue({
      taskId: "task-id",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "done",
      actionCache: {
        taskId: "task-id",
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });

    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: true,
    });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const internalAgent = agent as unknown as {
      actionCacheByTaskId: Record<string, unknown>;
    };
    internalAgent.actionCacheByTaskId = new Proxy(
      {},
      {
        set: () => {
          throw new Error("cache set trap");
        },
      }
    );

    const fakePage = {} as unknown as Page;
    try {
      const task = await agent.executeTaskAsync("test task", undefined, fakePage);
      await expect(task.result).resolves.toMatchObject({
        status: TaskStatus.COMPLETED,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to store action cache")
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("executeTask succeeds when action-cache assignment traps throw", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    mockedRunAgentTask.mockResolvedValue({
      taskId: "task-id",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "done",
      actionCache: {
        taskId: "task-id",
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });

    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: true,
    });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const internalAgent = agent as unknown as {
      actionCacheByTaskId: Record<string, unknown>;
    };
    internalAgent.actionCacheByTaskId = new Proxy(
      {},
      {
        set: () => {
          throw new Error("cache set trap");
        },
      }
    );

    const fakePage = {} as unknown as Page;
    try {
      await expect(agent.executeTask("sync task", undefined, fakePage)).resolves
        .toMatchObject({
          status: TaskStatus.COMPLETED,
        });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to store action cache")
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("executeTaskAsync succeeds when action-cache order access traps throw", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    mockedRunAgentTask.mockResolvedValue({
      taskId: "task-id",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "done",
      actionCache: {
        taskId: "task-id",
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });

    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: true,
    });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const internalAgent = agent as unknown as {
      actionCacheTaskOrder: string[];
    };
    Object.defineProperty(internalAgent, "actionCacheTaskOrder", {
      configurable: true,
      get: () => {
        throw new Error("cache order get trap");
      },
      set: () => {
        throw new Error("cache order set trap");
      },
    });

    const fakePage = {} as unknown as Page;
    try {
      const task = await agent.executeTaskAsync("test task", undefined, fakePage);
      await expect(task.result).resolves.toMatchObject({
        status: TaskStatus.COMPLETED,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to update action-cache order")
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("executeTask succeeds when action-cache order access traps throw", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    mockedRunAgentTask.mockResolvedValue({
      taskId: "task-id",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "done",
      actionCache: {
        taskId: "task-id",
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });

    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: true,
    });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const internalAgent = agent as unknown as {
      actionCacheTaskOrder: string[];
    };
    Object.defineProperty(internalAgent, "actionCacheTaskOrder", {
      configurable: true,
      get: () => {
        throw new Error("cache order get trap");
      },
      set: () => {
        throw new Error("cache order set trap");
      },
    });

    const fakePage = {} as unknown as Page;
    try {
      await expect(agent.executeTask("sync task", undefined, fakePage)).resolves
        .toMatchObject({
          status: TaskStatus.COMPLETED,
        });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to update action-cache order")
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("evicts oldest action caches when cache history exceeds limit", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    mockedRunAgentTask.mockImplementation((_, taskState) =>
      Promise.resolve({
        taskId: taskState.id,
        status: TaskStatus.COMPLETED,
        steps: [],
        output: "done",
        actionCache: {
          taskId: taskState.id,
          createdAt: new Date().toISOString(),
          status: TaskStatus.COMPLETED,
          steps: [],
        },
      })
    );

    const maxEntries = (
      HyperAgent as unknown as { MAX_ACTION_CACHE_ENTRIES: number }
    ).MAX_ACTION_CACHE_ENTRIES;
    const taskCount = maxEntries + 2;
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const fakePage = {} as unknown as Page;
    const taskIds: string[] = [];

    for (let i = 0; i < taskCount; i++) {
      const task = await agent.executeTaskAsync(
        `cache task ${i}`,
        undefined,
        fakePage
      );
      taskIds.push(task.id);
      await task.result;
    }

    expect(agent.getActionCache(taskIds[0] ?? "")).toBeNull();
    expect(agent.getActionCache(taskIds[1] ?? "")).toBeNull();
    const latestTaskId = taskIds[taskIds.length - 1] ?? "";
    expect(agent.getActionCache(latestTaskId)).not.toBeNull();
  });

  it("executeTaskAsync tolerates task-lifecycle cleanup deletion traps", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    mockedRunAgentTask.mockResolvedValue({
      taskId: "task-id",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "done",
      actionCache: {
        taskId: "task-id",
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });

    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: true,
    });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const internalAgent = agent as unknown as {
      taskResults: Record<string, Promise<AgentTaskOutput>>;
      tasks: Record<string, unknown>;
    };
    internalAgent.taskResults = new Proxy(
      {},
      {
        deleteProperty: () => {
          throw new Error("taskResults delete trap");
        },
      }
    ) as Record<string, Promise<AgentTaskOutput>>;
    internalAgent.tasks = new Proxy(
      {},
      {
        deleteProperty: () => {
          throw new Error("tasks delete trap");
        },
      }
    );

    const fakePage = {} as unknown as Page;
    try {
      const task = await agent.executeTaskAsync("test task", undefined, fakePage);
      await expect(task.result).resolves.toMatchObject({
        status: TaskStatus.COMPLETED,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to clear task result")
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to clear task state")
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("executeTask tolerates task-state cleanup deletion traps", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    mockedRunAgentTask.mockResolvedValue({
      taskId: "task-id",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "done",
      actionCache: {
        taskId: "task-id",
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });

    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: true,
    });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const internalAgent = agent as unknown as {
      tasks: Record<string, unknown>;
    };
    internalAgent.tasks = new Proxy(
      {},
      {
        deleteProperty: () => {
          throw new Error("tasks delete trap");
        },
      }
    );

    const fakePage = {} as unknown as Page;
    try {
      await expect(agent.executeTask("sync task", undefined, fakePage)).resolves
        .toMatchObject({
          status: TaskStatus.COMPLETED,
        });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to clear task state")
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("returns variable snapshots without exposing internal mutable store", () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    agent.addVariable({
      key: "email",
      value: "person@example.com",
      description: "Email",
    });

    const variables = agent.getVariables();
    variables.email = {
      key: "email",
      value: "mutated@example.com",
      description: "mutated",
    };

    expect(agent.getVariable("email")?.value).toBe("person@example.com");
  });

  it("rejects variables with invalid keys", () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });

    expect(() =>
      agent.addVariable({
        key: "   ",
        value: "value",
        description: "desc",
      })
    ).toThrow("Variable key must be a non-empty string");
  });

  it("returns null action cache for invalid cache identifiers", () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });

    const result = agent.getActionCache("   ");
    expect(result).toBeNull();
  });

  it("returns empty cache steps when cache step iteration traps throw", () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      actionCacheByTaskId: Record<string, unknown>;
    };
    internalAgent.actionCacheByTaskId["task-id"] = {
      taskId: "task-id",
      createdAt: new Date().toISOString(),
      status: TaskStatus.COMPLETED,
      steps: new Proxy(
        [],
        {
          get: (target, prop, receiver) => {
            if (prop === Symbol.iterator) {
              throw new Error("steps iterator trap");
            }
            return Reflect.get(target, prop, receiver);
          },
        }
      ),
    };

    const cache = agent.getActionCache("task-id");
    expect(cache?.steps).toEqual([]);
  });

  it("returns null when cached action-cache entry is not an object", () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      actionCacheByTaskId: Record<string, unknown>;
    };
    internalAgent.actionCacheByTaskId["task-id"] = 42;

    expect(agent.getActionCache("task-id")).toBeNull();
  });

  it("normalizes trap-prone cache metadata fields safely", () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      actionCacheByTaskId: Record<string, unknown>;
    };
    internalAgent.actionCacheByTaskId["task-id"] = {
      get taskId(): string {
        throw new Error("taskId trap");
      },
      get createdAt(): string {
        throw new Error("createdAt trap");
      },
      get status(): TaskStatus {
        throw new Error("status trap");
      },
      steps: [],
    };

    const cache = agent.getActionCache("task-id");

    expect(cache?.taskId).toBe("task-id");
    expect(cache?.createdAt).toBe("1970-01-01T00:00:00.000Z");
    expect(cache?.status).toBeUndefined();
    expect(cache?.steps).toEqual([]);
  });

  it("surfaces readable errors when getPages cannot enumerate context pages", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      browser: object | null;
      context: { pages: () => Page[] } | null;
    };
    internalAgent.browser = {};
    internalAgent.context = {
      pages: () => {
        throw new Error("pages trap");
      },
    };

    await expect(agent.getPages()).rejects.toThrow(
      "Failed to list pages from context: pages trap"
    );
  });

  it("surfaces readable errors when newPage creation fails", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      browser: object | null;
      context: { newPage: () => Promise<Page> } | null;
    };
    internalAgent.browser = {};
    internalAgent.context = {
      newPage: async () => {
        throw new Error("newPage trap");
      },
    };

    await expect(agent.newPage()).rejects.toThrow(
      "Failed to create new page: newPage trap"
    );
  });

  it("initBrowser surfaces readable errors when browser provider start fails", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      browserProvider: {
        start: () => Promise<unknown>;
        close: () => Promise<void>;
        getSession: () => unknown;
      };
      browser: unknown;
      context: unknown;
    };
    internalAgent.browserProvider = {
      start: async () => {
        throw new Error("start trap");
      },
      close: async () => undefined,
      getSession: () => null,
    };

    await expect(agent.initBrowser()).rejects.toThrow(
      "Failed to start browser provider: start trap"
    );
    expect(internalAgent.browser).toBeNull();
    expect(internalAgent.context).toBeNull();
  });

  it("initBrowser closes provider when Hyperbrowser context enumeration fails", async () => {
    const close = jest.fn(async () => undefined);
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      browserProviderType: "Hyperbrowser";
      browserProvider: {
        start: () => Promise<unknown>;
        close: typeof close;
        getSession: () => unknown;
      };
      browser: unknown;
      context: unknown;
    };
    internalAgent.browserProviderType = "Hyperbrowser";
    internalAgent.browserProvider = {
      start: async () => ({
        contexts: () => {
          throw new Error("contexts trap");
        },
      }),
      close,
      getSession: () => ({ id: "session-1" }),
    };

    await expect(agent.initBrowser()).rejects.toThrow(
      "Failed to list browser contexts: contexts trap"
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(internalAgent.browser).toBeNull();
    expect(internalAgent.context).toBeNull();
  });

  it("initBrowser tolerates context page-listener registration failures", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const context = {
      on: () => {
        throw new Error("context.on trap");
      },
    };
    const browser = {
      newContext: async () => context,
    };
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: true,
    });
    const internalAgent = agent as unknown as {
      browserProvider: {
        start: () => Promise<unknown>;
        close: () => Promise<void>;
        getSession: () => unknown;
      };
    };
    internalAgent.browserProvider = {
      start: async () => browser,
      close: async () => undefined,
      getSession: () => ({ id: "session-1" }),
    };

    try {
      await expect(agent.initBrowser()).resolves.toBe(browser);
      expect(warnSpy).toHaveBeenCalledWith(
        "[HyperAgent] Failed to attach browser page listener: context.on trap"
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("initBrowser aborts stale provider starts after closeAgent generation changes", async () => {
    const close = jest.fn(async () => undefined);
    let resolveStart!: (browser: unknown) => void;
    const startPromise = new Promise<unknown>((resolve) => {
      resolveStart = resolve;
    });
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      browserProvider: {
        start: () => Promise<unknown>;
        close: typeof close;
        getSession: () => unknown;
      };
      browser: unknown;
      context: unknown;
    };
    internalAgent.browserProvider = {
      start: () => startPromise,
      close,
      getSession: () => ({ id: "session-1" }),
    };

    const initPromise = agent.initBrowser();
    await expect(agent.closeAgent()).resolves.toBeUndefined();
    resolveStart({});

    await expect(initPromise).rejects.toThrow(
      "Browser initialization cancelled because agent was closed"
    );
    expect(close).toHaveBeenCalled();
    expect(internalAgent.browser).toBeNull();
    expect(internalAgent.context).toBeNull();
  });

  it("initBrowser recreates missing context for existing browser instances", async () => {
    const on = jest.fn();
    const context = { on };
    const browser = {
      newContext: async () => context,
    };
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      browser: unknown;
      context: unknown;
    };
    internalAgent.browser = browser;
    internalAgent.context = null;

    await expect(agent.initBrowser()).resolves.toBe(browser);
    expect(internalAgent.context).toBe(context);
    expect(on).toHaveBeenCalledWith("page", expect.any(Function));
  });

  it("initBrowser resets browser state when context recreation fails", async () => {
    const close = jest.fn(async () => undefined);
    const stalePage = {} as unknown as Page;
    const browser = {
      newContext: async () => {
        throw new Error("context rebuild trap");
      },
    };
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      browser: unknown;
      context: unknown;
      _currentPage: Page | null;
      browserProvider: {
        close: typeof close;
        getSession: () => unknown;
      };
    };
    internalAgent.browser = browser;
    internalAgent.context = null;
    internalAgent._currentPage = stalePage;
    internalAgent.browserProvider = {
      close,
      getSession: () => ({ id: "session-1" }),
    };

    await expect(agent.initBrowser()).rejects.toThrow(
      "Failed to create browser context: context rebuild trap"
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(internalAgent.browser).toBeNull();
    expect(internalAgent.context).toBeNull();
    expect(internalAgent._currentPage).toBeNull();
  });

  it("continues getPages when hyperpage context listener attachment fails", async () => {
    const page = {
      on: jest.fn(),
      context: () => ({
        on: () => {
          throw new Error("context listener trap");
        },
        off: jest.fn(),
      }),
      isClosed: () => false,
    } as unknown as Page;
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: true,
    });
    const logSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const internalAgent = agent as unknown as {
      browser: object | null;
      context: { pages: () => Page[] } | null;
    };
    internalAgent.browser = {};
    internalAgent.context = {
      pages: () => [page],
    };

    try {
      const pages = await agent.getPages();
      expect(pages).toHaveLength(1);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to attach context page listener")
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("returns null session when browser provider getSession throws", () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: true,
    });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const internalAgent = agent as unknown as {
      browserProvider: { getSession: () => unknown };
    };
    internalAgent.browserProvider = {
      getSession: () => {
        throw new Error("session trap");
      },
    };

    try {
      expect(agent.getSession()).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        "[HyperAgent] Failed to read browser session: session trap"
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("normalizes MCP server ids and handles invalid values", () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      mcpClient: {
        getServerIds: () => string[];
      } | null;
    };
    internalAgent.mcpClient = {
      getServerIds: () => ["server-a"],
    };

    expect(agent.isMCPServerConnected("  server-a  ")).toBe(true);
    expect(agent.isMCPServerConnected("   ")).toBe(false);
  });

  it("returns safe MCP server ids/info when MCP client access throws", () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      mcpClient:
        | {
            getServerIds: () => string[];
            getServerInfo: () => Array<{
              id: string;
              toolCount: number;
              toolNames: string[];
            }>;
          }
        | null;
    };
    internalAgent.mcpClient = {
      getServerIds: () => {
        throw new Error("serverIds trap");
      },
      getServerInfo: () => {
        throw new Error("serverInfo trap");
      },
    };

    expect(agent.getMCPServerIds()).toEqual([]);
    expect(agent.getMCPServerInfo()).toEqual([]);
  });

  it("disconnectFromMCPServer handles invalid IDs and server list traps", () => {
    const disconnectServer = jest.fn(async () => undefined);
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      mcpClient:
        | {
            getServerIds: () => string[];
            disconnectServer: typeof disconnectServer;
          }
        | null;
    };
    internalAgent.mcpClient = {
      getServerIds: () => {
        throw new Error("disconnect ids trap");
      },
      disconnectServer,
    };

    expect(agent.disconnectFromMCPServer("   ")).toBe(false);
    expect(agent.disconnectFromMCPServer("server-a")).toBe(false);
    expect(disconnectServer).not.toHaveBeenCalled();
  });

  it("disconnectFromMCPServerAsync handles invalid IDs and missing connections", async () => {
    const disconnectServer = jest.fn(async () => undefined);
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      mcpClient:
        | {
            getServerIds: () => string[];
            disconnectServer: typeof disconnectServer;
          }
        | null;
    };
    internalAgent.mcpClient = {
      getServerIds: () => ["server-a"],
      disconnectServer,
    };

    await expect(agent.disconnectFromMCPServerAsync("  ")).resolves.toBe(false);
    await expect(agent.disconnectFromMCPServerAsync("server-b")).resolves.toBe(
      false
    );
    await expect(agent.disconnectFromMCPServerAsync(" server-a ")).resolves.toBe(
      true
    );
    expect(disconnectServer).toHaveBeenCalledWith("server-a");
  });

  it("connectToMCPServer rejects non-object server configs", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });

    await expect(
      agent.connectToMCPServer(null as unknown as never)
    ).resolves.toBeNull();
  });

  it("rejects blank task descriptions for async and sync task execution", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const fakePage = {} as unknown as Page;

    await expect(
      agent.executeTaskAsync("   ", undefined, fakePage)
    ).rejects.toThrow("Action instruction must be a non-empty string");
    await expect(
      agent.executeTask("   ", undefined, fakePage)
    ).rejects.toThrow("Action instruction must be a non-empty string");
  });

  it("rejects invalid single-action instruction inputs", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const fakePage = {} as unknown as Page;

    await expect(
      agent.executeSingleAction("   ", fakePage)
    ).rejects.toThrow("Action instruction must be a non-empty string");
  });

  it("surfaces readable errors when single-action page getter traps throw", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });

    await expect(
      agent.executeSingleAction("click submit", () => {
        throw new Error("page getter trap");
      })
    ).rejects.toThrow("Failed to resolve action page: page getter trap");
  });

  it("normalizes invalid maxContextSwitchRetries for hyperPage.perform retries", async () => {
    const page = {
      on: jest.fn(),
      off: jest.fn(),
      context: () => ({
        on: jest.fn(),
        off: jest.fn(),
        pages: () => [page],
      }),
      isClosed: () => false,
    } as unknown as Page;
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      browser: object | null;
      context: { pages: () => Page[] } | null;
      executeSingleAction: jest.Mock;
    };
    internalAgent.browser = {};
    internalAgent.context = {
      pages: () => [page],
    };
    internalAgent.executeSingleAction = jest
      .fn()
      .mockRejectedValueOnce(
        new HyperagentError("Page context switched during execution", 409)
      )
      .mockResolvedValue({
        taskId: "task-id",
        status: TaskStatus.COMPLETED,
        steps: [],
        output: "done",
      });

    const [hyperPage] = await agent.getPages();
    const result = await hyperPage.perform("click submit", {
      maxContextSwitchRetries: 0,
    });

    expect(result.status).toBe(TaskStatus.COMPLETED);
    expect(internalAgent.executeSingleAction).toHaveBeenCalledTimes(2);
  });

  it("hyperPage.extract rejects blank task descriptions when provided", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    mockedRunAgentTask.mockResolvedValue({
      taskId: "task-id",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "done",
      actionCache: {
        taskId: "task-id",
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });

    const page = {
      on: jest.fn(),
      off: jest.fn(),
      context: () => ({
        on: jest.fn(),
        off: jest.fn(),
        pages: () => [page],
      }),
      isClosed: () => false,
      url: () => "https://example.com",
    } as unknown as Page;
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      browser: object | null;
      context: { pages: () => Page[] } | null;
    };
    internalAgent.browser = {};
    internalAgent.context = {
      pages: () => [page],
    };

    const [hyperPage] = await agent.getPages();
    await expect(
      hyperPage.extract("   ")
    ).rejects.toThrow("Task description must be non-empty when provided");
    expect(mockedRunAgentTask).not.toHaveBeenCalled();
  });

  it("hyperPage.extract normalizes maxSteps and task prompt input", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    mockedRunAgentTask.mockResolvedValue({
      taskId: "task-id",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "done",
      actionCache: {
        taskId: "task-id",
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });

    const page = {
      on: jest.fn(),
      off: jest.fn(),
      context: () => ({
        on: jest.fn(),
        off: jest.fn(),
        pages: () => [page],
      }),
      isClosed: () => false,
      url: () => "https://example.com",
    } as unknown as Page;
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      browser: object | null;
      context: { pages: () => Page[] } | null;
    };
    internalAgent.browser = {};
    internalAgent.context = {
      pages: () => [page],
    };

    const [hyperPage] = await agent.getPages();
    await hyperPage.extract("  summarize inventory  ", undefined, {
      maxSteps: Number.NaN,
    });

    const taskStateArg = mockedRunAgentTask.mock.calls[0]?.[1] as {
      task: string;
    };
    const paramsArg = mockedRunAgentTask.mock.calls[0]?.[2] as {
      maxSteps?: number;
    };
    expect(taskStateArg.task).toContain("summarize inventory");
    expect(taskStateArg.task).not.toContain("  summarize inventory  ");
    expect(paramsArg.maxSteps).toBe(2);
  });

  it("returns empty pprint output for malformed action payloads", () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const badAction = {
      get type(): string {
        throw new Error("type trap");
      },
      params: {},
    };

    expect(agent.pprintAction(badAction as never)).toBe("");
  });

  it("returns empty pprint output when custom pprintAction throws", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const throwingAction: AgentActionDefinition = {
      type: "customPprint",
      actionParams: z.object({}),
      run: async () => ({ success: true, message: "ok" }),
      pprintAction: () => {
        throw new Error("pprint failed");
      },
    };
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: true,
      customActions: [throwingAction],
    });

    try {
      expect(
        agent.pprintAction({
          type: "customPprint",
          params: {},
        } as never)
      ).toBe("");
      expect(warnSpy).toHaveBeenCalledWith(
        '[HyperAgent] Failed to pprint action "customPprint": pprint failed'
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("creates scripts from iterable action-cache steps", () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const step: ActionCacheEntry = {
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
    };
    const script = agent.createScriptFromActionCache(
      new Set([step]) as unknown as ActionCacheEntry[],
      "  task-id  "
    );

    expect(script).toContain("performClick");
  });

  it("throws readable errors when action-cache steps are unreadable", () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const trappedSteps = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === Symbol.iterator) {
            throw new Error("steps iterator trap");
          }
          return undefined;
        },
      }
    ) as unknown as ActionCacheEntry[];

    expect(() => agent.createScriptFromActionCache(trappedSteps)).toThrow(
      "Failed to read action cache steps: steps iterator trap"
    );
  });

  it("executeTaskAsync tolerates context listener attachment failures", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    mockedRunAgentTask.mockResolvedValue({
      taskId: "task-id",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "done",
      actionCache: {
        taskId: "task-id",
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });

    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      context: { on: (event: string, handler: unknown) => void } | null;
    };
    internalAgent.context = {
      on: () => {
        throw new Error("context on trap");
      },
    };

    const fakePage = {} as unknown as Page;
    const task = await agent.executeTaskAsync("test task", undefined, fakePage);

    await expect(task.result).resolves.toMatchObject({
      status: TaskStatus.COMPLETED,
      output: "done",
    });
  });

  it("executeTask tolerates context listener detach failures", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    mockedRunAgentTask.mockResolvedValue({
      taskId: "task-id",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "done",
      actionCache: {
        taskId: "task-id",
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });

    const on = jest.fn();
    const off = jest.fn(() => {
      throw new Error("context off trap");
    });
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      context: {
        on: typeof on;
        off: typeof off;
      } | null;
    };
    internalAgent.context = { on, off };

    const fakePage = {} as unknown as Page;
    const result = await agent.executeTask("test task", undefined, fakePage);

    expect(result.status).toBe(TaskStatus.COMPLETED);
    expect(off).toHaveBeenCalledWith("page", expect.any(Function));
  });

  it("handles trap-prone tab URL reads in task page-follow callback", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    mockedRunAgentTask.mockResolvedValue({
      taskId: "task-id",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "done",
      actionCache: {
        taskId: "task-id",
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });

    const on = jest.fn();
    const off = jest.fn();
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: true,
    });
    const internalAgent = agent as unknown as {
      context: {
        on: typeof on;
        off: typeof off;
      } | null;
    };
    internalAgent.context = { on, off };

    const fakePage = {} as unknown as Page;
    const task = await agent.executeTaskAsync("test task", undefined, fakePage);
    const onPageHandler = on.mock.calls[0]?.[1] as (page: Page) => Promise<void>;
    const popupPage = {
      opener: async () => fakePage,
      url: () => {
        throw new Error("url trap");
      },
    } as unknown as Page;

    try {
      await expect(onPageHandler(popupPage)).resolves.toBeUndefined();
      await expect(task.result).resolves.toMatchObject({
        status: TaskStatus.COMPLETED,
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("getCurrentPage tolerates context.pages traps when current page exists", async () => {
    const page = {
      on: jest.fn(),
      off: jest.fn(),
      context: () => ({
        on: jest.fn(),
        off: jest.fn(),
        pages: () => [page],
      }),
      isClosed: () => false,
      url: () => "https://example.com",
    } as unknown as Page;
    const newPage = jest.fn();
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      browser: object | null;
      context: { pages: () => Page[]; newPage: typeof newPage } | null;
      _currentPage: Page | null;
    };
    internalAgent.browser = {};
    internalAgent.context = {
      pages: () => {
        throw new Error("pages trap");
      },
      newPage,
    };
    internalAgent._currentPage = page;

    const currentPage = await agent.getCurrentPage();

    expect(currentPage).toBe(page);
    expect(newPage).not.toHaveBeenCalled();
  });

  it("getCurrentPage surfaces readable errors when newPage creation fails", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      browser: object | null;
      context: {
        pages: () => Page[];
        newPage: () => Promise<Page>;
      } | null;
    };
    internalAgent.browser = {};
    internalAgent.context = {
      pages: () => [],
      newPage: async () => {
        throw new Error("new current page trap");
      },
    };

    await expect(agent.getCurrentPage()).rejects.toThrow(
      "Failed to create current page: new current page trap"
    );
  });

  it("task controls return safe status when task state traps throw", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    let resolveTaskResult!: (value: AgentTaskOutput) => void;
    const pendingResult = new Promise<AgentTaskOutput>((resolve) => {
      resolveTaskResult = resolve;
    });
    mockedRunAgentTask.mockReturnValue(pendingResult);

    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const fakePage = {} as unknown as Page;
    const task = await agent.executeTaskAsync("test task", undefined, fakePage);
    const internalAgent = agent as unknown as {
      tasks: Record<string, { status: TaskStatus }>;
    };
    const trappedTaskState = internalAgent.tasks[task.id];
    Object.defineProperty(trappedTaskState, "status", {
      configurable: true,
      get: () => {
        throw new Error("status trap");
      },
      set: () => {
        throw new Error("status set trap");
      },
    });

    expect(task.getStatus()).toBe(TaskStatus.FAILED);
    expect(task.pause()).toBe(TaskStatus.FAILED);
    expect(task.resume()).toBe(TaskStatus.FAILED);
    expect(task.cancel()).toBe(TaskStatus.FAILED);

    resolveTaskResult({
      taskId: task.id,
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "done",
      actionCache: {
        taskId: task.id,
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });
    await expect(task.result).resolves.toMatchObject({
      status: TaskStatus.COMPLETED,
    });
  });

  it("closeAgent tolerates trap-prone task status fields", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const taskA = {
      status: TaskStatus.RUNNING,
    };
    const internalAgent = agent as unknown as {
      tasks: Record<string, { status: TaskStatus }>;
    };
    internalAgent.tasks["task-a"] = taskA;
    const trappedTask = {};
    Object.defineProperty(trappedTask, "status", {
      configurable: true,
      get: () => {
        throw new Error("close status trap");
      },
      set: () => {
        throw new Error("close status trap");
      },
    });
    internalAgent.tasks["task-b"] = trappedTask as { status: TaskStatus };

    await expect(agent.closeAgent()).resolves.toBeUndefined();
    expect(taskA.status).toBe(TaskStatus.CANCELLED);
    expect(internalAgent.tasks).toEqual({});
  });

  it("closeAgent closes browser provider when session exists without browser", async () => {
    const close = jest.fn(async () => undefined);
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      browser: null;
      context: null;
      browserProvider: {
        close: typeof close;
        getSession: () => unknown;
      };
    };
    internalAgent.browser = null;
    internalAgent.context = null;
    internalAgent.browserProvider = {
      close,
      getSession: () => ({ id: "session-1" }),
    };

    await expect(agent.closeAgent()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closeAgent clears stale current-page references", async () => {
    const close = jest.fn(async () => undefined);
    const stalePage = {} as unknown as Page;
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      browser: object | null;
      context: object | null;
      _currentPage: Page | null;
      browserProvider: {
        close: typeof close;
        getSession: () => unknown;
      };
    };
    internalAgent.browser = {};
    internalAgent.context = {};
    internalAgent._currentPage = stalePage;
    internalAgent.browserProvider = {
      close,
      getSession: () => ({ id: "session-1" }),
    };

    await expect(agent.closeAgent()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    expect(internalAgent._currentPage).toBeNull();
  });

  it("closeAgent clears internal async task-result cache", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const internalAgent = agent as unknown as {
      taskResults: Record<string, Promise<AgentTaskOutput>>;
      actionCacheByTaskId: Record<string, unknown>;
    };
    internalAgent.taskResults = {
      "task-a": Promise.resolve({
        taskId: "task-a",
        status: TaskStatus.COMPLETED,
        steps: [],
        output: "done",
        actionCache: {
          taskId: "task-a",
          createdAt: new Date().toISOString(),
          status: TaskStatus.COMPLETED,
          steps: [],
        },
      }),
    };
    internalAgent.actionCacheByTaskId = {
      "task-a": {
        taskId: "task-a",
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    };

    await expect(agent.closeAgent()).resolves.toBeUndefined();
    expect(internalAgent.taskResults).toEqual({});
    expect(internalAgent.actionCacheByTaskId).toEqual({});
  });

  it("closeAgent tolerates trapped task-registry enumeration", async () => {
    const close = jest.fn(async () => undefined);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: true,
    });
    const internalAgent = agent as unknown as {
      tasks: Record<string, { status: TaskStatus }>;
      browserProvider: {
        close: typeof close;
        getSession: () => unknown;
      };
      browser: null;
      context: null;
    };
    internalAgent.tasks = new Proxy(
      {
        "task-a": { status: TaskStatus.RUNNING },
      },
      {
        ownKeys: () => {
          throw new Error("task entries trap");
        },
      }
    ) as unknown as Record<string, { status: TaskStatus }>;
    internalAgent.browserProvider = {
      close,
      getSession: () => ({ id: "session-1" }),
    };
    internalAgent.browser = null;
    internalAgent.context = null;

    try {
      await expect(agent.closeAgent()).resolves.toBeUndefined();
      expect(close).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to enumerate tasks during close")
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("task controls stay cancelled after close despite late task-state mutations", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    let resolveTask!: (value: AgentTaskOutput) => void;
    let capturedTaskState: TaskState | undefined;
    mockedRunAgentTask.mockImplementation((_, taskState) => {
      capturedTaskState = taskState;
      return new Promise<AgentTaskOutput>((resolve) => {
        resolveTask = resolve;
      });
    });

    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const fakePage = {} as unknown as Page;
    const task = await agent.executeTaskAsync("shutdown control", undefined, fakePage);

    await expect(agent.closeAgent()).resolves.toBeUndefined();
    expect(task.getStatus()).toBe(TaskStatus.CANCELLED);
    if (capturedTaskState) {
      capturedTaskState.status = TaskStatus.RUNNING;
    }
    expect(task.getStatus()).toBe(TaskStatus.CANCELLED);
    expect(task.pause()).toBe(TaskStatus.CANCELLED);
    expect(task.resume()).toBe(TaskStatus.CANCELLED);
    expect(task.cancel()).toBe(TaskStatus.CANCELLED);

    resolveTask({
      taskId: task.id,
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "done",
      actionCache: {
        taskId: task.id,
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });
    await expect(task.result).resolves.toMatchObject({
      status: TaskStatus.CANCELLED,
    });
  });

  it("task controls keep completed status after settlement despite late mutations", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    let resolveTask!: (value: AgentTaskOutput) => void;
    let capturedTaskState: TaskState | undefined;
    mockedRunAgentTask.mockImplementation((_, taskState) => {
      capturedTaskState = taskState;
      return new Promise<AgentTaskOutput>((resolve) => {
        resolveTask = resolve;
      });
    });

    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const fakePage = {} as unknown as Page;
    const task = await agent.executeTaskAsync("complete control", undefined, fakePage);

    resolveTask({
      taskId: task.id,
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "done",
      actionCache: {
        taskId: task.id,
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });

    await expect(task.result).resolves.toMatchObject({
      status: TaskStatus.COMPLETED,
    });
    expect(task.getStatus()).toBe(TaskStatus.COMPLETED);
    if (capturedTaskState) {
      capturedTaskState.status = TaskStatus.RUNNING;
    }
    expect(task.getStatus()).toBe(TaskStatus.COMPLETED);
    expect(task.cancel()).toBe(TaskStatus.COMPLETED);
    expect(task.pause()).toBe(TaskStatus.COMPLETED);
    expect(task.resume()).toBe(TaskStatus.COMPLETED);
  });

  it("task controls keep failed status after settlement despite late mutations", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    let rejectTask!: (error: unknown) => void;
    let capturedTaskState: TaskState | undefined;
    mockedRunAgentTask.mockImplementation((_, taskState) => {
      capturedTaskState = taskState;
      return new Promise<AgentTaskOutput>((_, reject) => {
        rejectTask = reject;
      });
    });

    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const fakePage = {} as unknown as Page;
    const task = await agent.executeTaskAsync("fail control", undefined, fakePage);

    rejectTask(new Error("control failure"));
    await expect(task.result).rejects.toBeInstanceOf(HyperagentTaskError);
    expect(task.getStatus()).toBe(TaskStatus.FAILED);
    if (capturedTaskState) {
      capturedTaskState.status = TaskStatus.RUNNING;
    }
    expect(task.getStatus()).toBe(TaskStatus.FAILED);
    expect(task.cancel()).toBe(TaskStatus.FAILED);
    expect(task.pause()).toBe(TaskStatus.FAILED);
    expect(task.resume()).toBe(TaskStatus.FAILED);
  });

  it("task controls keep cancelled status after manual cancellation settles", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    let resolveTask!: (value: AgentTaskOutput) => void;
    let capturedTaskState: TaskState | undefined;
    mockedRunAgentTask.mockImplementation((_, taskState) => {
      capturedTaskState = taskState;
      return new Promise<AgentTaskOutput>((resolve) => {
        resolveTask = resolve;
      });
    });

    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const fakePage = {} as unknown as Page;
    const task = await agent.executeTaskAsync("cancel control", undefined, fakePage);

    expect(task.cancel()).toBe(TaskStatus.CANCELLED);
    resolveTask({
      taskId: task.id,
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "done",
      actionCache: {
        taskId: task.id,
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });

    await expect(task.result).resolves.toMatchObject({
      status: TaskStatus.CANCELLED,
      output: "Task was cancelled",
    });
    expect(task.getStatus()).toBe(TaskStatus.CANCELLED);
    if (capturedTaskState) {
      capturedTaskState.status = TaskStatus.RUNNING;
    }
    expect(task.getStatus()).toBe(TaskStatus.CANCELLED);
    expect(task.cancel()).toBe(TaskStatus.CANCELLED);
    expect(task.pause()).toBe(TaskStatus.CANCELLED);
    expect(task.resume()).toBe(TaskStatus.CANCELLED);
  });

  it("closeAgent prevents in-flight async tasks from repopulating action cache", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    let resolveTask!: (value: AgentTaskOutput) => void;
    mockedRunAgentTask.mockImplementation(
      () =>
        new Promise<AgentTaskOutput>((resolve) => {
          resolveTask = resolve;
        })
    );

    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const fakePage = {} as unknown as Page;
    const task = await agent.executeTaskAsync("long running", undefined, fakePage);
    const internalAgent = agent as unknown as {
      actionCacheByTaskId: Record<string, unknown>;
    };

    await expect(agent.closeAgent()).resolves.toBeUndefined();
    resolveTask({
      taskId: task.id,
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "done",
      actionCache: {
        taskId: task.id,
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });
    await expect(task.result).resolves.toMatchObject({
      status: TaskStatus.CANCELLED,
      output: "Task cancelled because agent was closed",
      actionCache: { status: TaskStatus.CANCELLED },
    });
    expect(task.getStatus()).toBe(TaskStatus.CANCELLED);
    expect(internalAgent.actionCacheByTaskId).toEqual({});
  });

  it("executeTask returns cancelled output when closeAgent occurs mid-run", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    let resolveTask!: (value: AgentTaskOutput) => void;
    mockedRunAgentTask.mockImplementation(
      () =>
        new Promise<AgentTaskOutput>((resolve) => {
          resolveTask = resolve;
        })
    );

    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const fakePage = {} as unknown as Page;
    const execution = agent.executeTask("sync long running", undefined, fakePage);

    await expect(agent.closeAgent()).resolves.toBeUndefined();
    resolveTask({
      taskId: "sync-task",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "done",
      actionCache: {
        taskId: "sync-task",
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });

    await expect(execution).resolves.toMatchObject({
      status: TaskStatus.CANCELLED,
      output: "Task cancelled because agent was closed",
      actionCache: { status: TaskStatus.CANCELLED },
    });
  });

  it("uses default cancelled output for async tasks closed before completion", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    let resolveTask!: (value: AgentTaskOutput) => void;
    mockedRunAgentTask.mockImplementation(
      () =>
        new Promise<AgentTaskOutput>((resolve) => {
          resolveTask = resolve;
        })
    );

    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const fakePage = {} as unknown as Page;
    const task = await agent.executeTaskAsync(
      "async no output",
      undefined,
      fakePage
    );
    await expect(agent.closeAgent()).resolves.toBeUndefined();

    resolveTask({
      taskId: task.id,
      status: TaskStatus.COMPLETED,
      steps: [],
      output: undefined,
      actionCache: {
        taskId: task.id,
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });

    await expect(task.result).resolves.toMatchObject({
      status: TaskStatus.CANCELLED,
      output: "Task cancelled because agent was closed",
      actionCache: { status: TaskStatus.CANCELLED },
    });
  });

  it("uses default cancelled output for sync tasks closed before completion", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    let resolveTask!: (value: AgentTaskOutput) => void;
    mockedRunAgentTask.mockImplementation(
      () =>
        new Promise<AgentTaskOutput>((resolve) => {
          resolveTask = resolve;
        })
    );

    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const fakePage = {} as unknown as Page;
    const execution = agent.executeTask("sync no output", undefined, fakePage);
    await expect(agent.closeAgent()).resolves.toBeUndefined();

    resolveTask({
      taskId: "sync-no-output",
      status: TaskStatus.COMPLETED,
      steps: [],
      output: undefined,
      actionCache: {
        taskId: "sync-no-output",
        createdAt: new Date().toISOString(),
        status: TaskStatus.COMPLETED,
        steps: [],
      },
    });

    await expect(execution).resolves.toMatchObject({
      status: TaskStatus.CANCELLED,
      output: "Task cancelled because agent was closed",
      actionCache: { status: TaskStatus.CANCELLED },
    });
  });

  it("closeAgent avoids noisy missing-task logs for late async failures", async () => {
    const mockedRunAgentTask = jest.mocked(runAgentTask);
    let rejectTask!: (error: unknown) => void;
    mockedRunAgentTask.mockImplementation(
      () =>
        new Promise<AgentTaskOutput>((_, reject) => {
          rejectTask = reject;
        })
    );

    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const agent = new HyperAgent({
      llm: createMockLLM(),
    });
    const fakePage = {} as unknown as Page;
    const task = await agent.executeTaskAsync("late failure", undefined, fakePage);

    try {
      await expect(agent.closeAgent()).resolves.toBeUndefined();
      rejectTask(new Error("late boom"));
      await expect(task.result).resolves.toMatchObject({
        status: TaskStatus.CANCELLED,
        output: "Task cancelled because agent was closed",
        actionCache: { status: TaskStatus.CANCELLED },
      });
      expect(errorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Task state")
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
