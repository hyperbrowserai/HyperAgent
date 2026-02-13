import { z } from "zod";
import type { Page } from "playwright-core";
import { HyperAgent } from "@/agent";
import { getDebugOptions, setDebugOptions } from "@/debug/options";
import type { AgentActionDefinition } from "@/types";
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
    const internalAgent = agent as unknown as {
      tasks: Record<string, { status: TaskStatus }>;
    };
    internalAgent.tasks["task-a"] = {
      status: TaskStatus.RUNNING,
    };
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
    expect(internalAgent.tasks["task-a"]?.status).toBe(TaskStatus.CANCELLED);
  });
});
