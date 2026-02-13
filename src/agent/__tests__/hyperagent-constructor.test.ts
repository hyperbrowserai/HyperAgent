import { z } from "zod";
import type { Page } from "playwright-core";
import { HyperAgent } from "@/agent";
import { getDebugOptions, setDebugOptions } from "@/debug/options";
import type { AgentActionDefinition } from "@/types";
import type { HyperAgentLLM } from "@/llm/types";
import { runAgentTask } from "@/agent/tools/agent";
import { TaskStatus } from "@/types/agent/types";
import { HyperagentTaskError } from "@/agent/error";

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
});
