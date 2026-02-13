import { z } from "zod";
import type { Page } from "playwright-core";
import fs from "fs";
import * as cdp from "@/cdp";
import type { AgentActionDefinition } from "@/types";
import type { AgentCtx } from "@/agent/tools/types";
import { TaskStatus, type TaskState } from "@/types/agent/types";
import { runAgentTask } from "@/agent/tools/agent";

jest.mock("@/agent/shared/dom-capture", () => ({
  captureDOMState: jest.fn(),
}));

jest.mock("@/utils/waitForSettledDOM", () => ({
  waitForSettledDOM: jest.fn(),
}));

jest.mock("@/agent/shared/runtime-context", () => ({
  initializeRuntimeContext: jest.fn(),
}));

jest.mock("@/agent/messages/builder", () => ({
  buildAgentStepMessages: jest.fn(),
}));

const { captureDOMState } = jest.requireMock("@/agent/shared/dom-capture") as {
  captureDOMState: jest.Mock;
};
const { waitForSettledDOM } = jest.requireMock("@/utils/waitForSettledDOM") as {
  waitForSettledDOM: jest.Mock;
};
const { initializeRuntimeContext } = jest.requireMock(
  "@/agent/shared/runtime-context"
) as {
  initializeRuntimeContext: jest.Mock;
};
const { buildAgentStepMessages } = jest.requireMock("@/agent/messages/builder") as {
  buildAgentStepMessages: jest.Mock;
};

function createMockPage(): Page {
  return {
    on: jest.fn(),
    off: jest.fn(),
    url: () => "https://example.com",
  } as unknown as Page;
}

function createCompleteActionDefinition(): AgentActionDefinition {
  return {
    type: "complete",
    actionParams: z.object({
      success: z.boolean(),
      text: z.string().optional(),
    }),
    run: async (_ctx, params) => {
      if (params.success) {
        return { success: true, message: "task complete" };
      }
      return { success: false, message: "task failed by model decision" };
    },
    completeAction: async (params) => params.text ?? "task complete",
  };
}

function createAgentCtx(
  actionOutput: { success: boolean; text?: string }
): AgentCtx {
  const parsedAction = {
    thoughts: "done",
    memory: "done",
    action: {
      type: "complete",
      params: {
        success: actionOutput.success,
        text: actionOutput.text,
      },
    },
  };

  const llm = {
    invoke: async () => ({
      role: "assistant" as const,
      content: "ok",
    }),
    invokeStructured: async () => ({
      rawText: JSON.stringify(actionOutput),
      parsed: parsedAction,
    }),
    getProviderId: () => "mock",
    getModelId: () => "mock-model",
    getCapabilities: () => ({
      multimodal: false,
      toolCalling: true,
      jsonMode: true,
    }),
  } as unknown as AgentCtx["llm"];

  return {
    llm,
    actions: [createCompleteActionDefinition()],
    tokenLimit: 10000,
    debug: false,
    variables: {},
    cdpActions: false,
  };
}

function createThrowingCompleteCtx(errorMessage: string): AgentCtx {
  const parsedAction = {
    thoughts: "done",
    memory: "done",
    action: {
      type: "complete",
      params: {
        success: true,
        text: "unused",
      },
    },
  };

  const llm = {
    invoke: async () => ({
      role: "assistant" as const,
      content: "ok",
    }),
    invokeStructured: async () => ({
      rawText: "{}",
      parsed: parsedAction,
    }),
    getProviderId: () => "mock",
    getModelId: () => "mock-model",
    getCapabilities: () => ({
      multimodal: false,
      toolCalling: true,
      jsonMode: true,
    }),
  } as unknown as AgentCtx["llm"];

  return {
    llm,
    actions: [
      {
        type: "complete",
        actionParams: z.object({
          success: z.boolean(),
          text: z.string().optional(),
        }),
        run: async () => {
          throw new Error(errorMessage);
        },
      },
    ],
    tokenLimit: 10000,
    debug: false,
    variables: {},
    cdpActions: false,
  };
}

function createThrowingObjectCtx(): AgentCtx {
  const parsedAction = {
    thoughts: "done",
    memory: "done",
    action: {
      type: "complete",
      params: {
        success: true,
        text: "unused",
      },
    },
  };

  const llm = {
    invoke: async () => ({
      role: "assistant" as const,
      content: "ok",
    }),
    invokeStructured: async () => ({
      rawText: "{}",
      parsed: parsedAction,
    }),
    getProviderId: () => "mock",
    getModelId: () => "mock-model",
    getCapabilities: () => ({
      multimodal: false,
      toolCalling: true,
      jsonMode: true,
    }),
  } as unknown as AgentCtx["llm"];

  return {
    llm,
    actions: [
      {
        type: "complete",
        actionParams: z.object({
          success: z.boolean(),
          text: z.string().optional(),
        }),
        run: async () => {
          throw { reason: "object failure" };
        },
      },
    ],
    tokenLimit: 10000,
    debug: false,
    variables: {},
    cdpActions: false,
  };
}

function createTaskState(page: Page): TaskState {
  return {
    id: "task-1",
    task: "finish now",
    status: TaskStatus.PENDING,
    startingPage: page,
    steps: [],
  };
}

describe("runAgentTask completion behavior", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    captureDOMState.mockResolvedValue({
      elements: new Map(),
      domState: "dom",
      xpathMap: {},
      backendNodeMap: {},
      frameMap: new Map(),
    });
    waitForSettledDOM.mockResolvedValue({
      durationMs: 1,
      lifecycleMs: 0,
      networkMs: 1,
      requestsSeen: 0,
      peakInflight: 0,
      resolvedByTimeout: false,
      forcedDrops: 0,
    });
    initializeRuntimeContext.mockResolvedValue({
      cdpClient: {},
      frameContextManager: {},
    });
    buildAgentStepMessages.mockResolvedValue([]);
  });

  it("marks task completed when complete action succeeds", async () => {
    const page = createMockPage();
    const result = await runAgentTask(
      createAgentCtx({ success: true, text: "final answer" }),
      createTaskState(page)
    );

    expect(result.status).toBe(TaskStatus.COMPLETED);
    expect(result.output).toBe("final answer");
    expect(result.steps).toHaveLength(1);
  });

  it("marks task failed when complete action signals failure", async () => {
    const page = createMockPage();
    const result = await runAgentTask(
      createAgentCtx({ success: false, text: "nope" }),
      createTaskState(page)
    );

    expect(result.status).toBe(TaskStatus.FAILED);
    expect(result.output).toBe("task failed by model decision");
    expect(result.steps).toHaveLength(1);
  });

  it("surfaces thrown action errors with readable messages", async () => {
    const page = createMockPage();
    const result = await runAgentTask(
      createThrowingCompleteCtx("intentional failure"),
      createTaskState(page)
    );

    expect(result.status).toBe(TaskStatus.FAILED);
    expect(result.output).toContain("Action complete failed: intentional failure");
  });

  it("serializes non-Error thrown values in action failures", async () => {
    const page = createMockPage();
    const result = await runAgentTask(
      createThrowingObjectCtx(),
      createTaskState(page)
    );

    expect(result.status).toBe(TaskStatus.FAILED);
    expect(result.output).toContain('Action complete failed: {"reason":"object failure"}');
  });

  it("does not fail task when debug artifact IO throws", async () => {
    const page = createMockPage();
    const mkdirSpy = jest.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw new Error("mkdir denied");
    });
    const writeSpy = jest.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("write denied");
    });
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const ctx = createAgentCtx({ success: true, text: "final answer" });
    ctx.debug = true;

    try {
      const result = await runAgentTask(ctx, createTaskState(page), {
        debugDir: "debug/test",
      });

      expect(result.status).toBe(TaskStatus.COMPLETED);
      expect(errorSpy).toHaveBeenCalled();
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      mkdirSpy.mockRestore();
      writeSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("continues task when visual screenshot composition fails", async () => {
    const page = createMockPage();
    const getCDPClientSpy = jest
      .spyOn(cdp, "getCDPClient")
      .mockRejectedValue(new Error("cdp screenshot unavailable"));
    captureDOMState.mockResolvedValue({
      elements: new Map(),
      domState: "dom",
      xpathMap: {},
      backendNodeMap: {},
      frameMap: new Map(),
      visualOverlay: "overlay-base64",
    });

    try {
      const result = await runAgentTask(
        createAgentCtx({ success: true, text: "final answer" }),
        createTaskState(page),
        { enableVisualMode: true }
      );

      expect(result.status).toBe(TaskStatus.COMPLETED);
      expect(result.output).toBe("final answer");
    } finally {
      getCDPClientSpy.mockRestore();
    }
  });
});
