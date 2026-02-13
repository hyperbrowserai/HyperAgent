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

function createSchemaRetryCtx(rawText: string): AgentCtx {
  const parsedAction = {
    thoughts: "done",
    memory: "done",
    action: {
      type: "complete",
      params: {
        success: true,
        text: "final answer",
      },
    },
  };

  const invokeStructured = jest
    .fn()
    .mockResolvedValueOnce({
      rawText,
      parsed: null,
    })
    .mockResolvedValue({
      rawText: JSON.stringify(parsedAction),
      parsed: parsedAction,
    });

  const llm = {
    invoke: async () => ({
      role: "assistant" as const,
      content: "ok",
    }),
    invokeStructured,
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

function createTransientStructuredFailureCtx(): AgentCtx {
  const parsedAction = {
    thoughts: "done",
    memory: "done",
    action: {
      type: "complete",
      params: {
        success: true,
        text: "final answer",
      },
    },
  };

  const invokeStructured = jest
    .fn()
    .mockRejectedValueOnce({ reason: "temporary llm failure" })
    .mockResolvedValue({
      rawText: JSON.stringify(parsedAction),
      parsed: parsedAction,
    });

  const llm = {
    invoke: async () => ({
      role: "assistant" as const,
      content: "ok",
    }),
    invokeStructured,
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

function createCircularParamsStepCtx(): AgentCtx {
  const circularParams: Record<string, unknown> = { id: "progress" };
  circularParams.self = circularParams;

  const nonCompleteAction = {
    thoughts: "progress",
    memory: "progress",
    action: {
      type: "recordProgress",
      params: circularParams,
    },
  };

  const completeAction = {
    thoughts: "done",
    memory: "done",
    action: {
      type: "complete",
      params: {
        success: true,
        text: "final answer",
      },
    },
  };

  const invokeStructured = jest
    .fn()
    .mockResolvedValueOnce({
      rawText: "{}",
      parsed: nonCompleteAction,
    })
    .mockResolvedValueOnce({
      rawText: "{}",
      parsed: completeAction,
    });

  const llm = {
    invoke: async () => ({
      role: "assistant" as const,
      content: "ok",
    }),
    invokeStructured,
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
        type: "recordProgress",
        actionParams: z.record(z.string(), z.unknown()),
        run: async () => ({
          success: true,
          message: "progress saved",
        }),
      },
      createCompleteActionDefinition(),
    ],
    tokenLimit: 10000,
    debug: false,
    variables: {},
    cdpActions: false,
  };
}

function createSchemaErrorSummaryCtx(): AgentCtx {
  const parsedAction = {
    thoughts: "done",
    memory: "done",
    action: {
      type: "complete",
      params: {
        success: true,
        text: "final answer",
      },
    },
  };

  const invokeStructured = jest.fn().mockResolvedValue({
    rawText: JSON.stringify(parsedAction),
    parsed: parsedAction,
  });

  const llm = {
    invoke: async () => ({
      role: "assistant" as const,
      content: "ok",
    }),
    invokeStructured,
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
    schemaErrors: [
      { stepIndex: 10, error: "x".repeat(3000), rawResponse: "{}" },
      { stepIndex: 11, error: "y".repeat(3000), rawResponse: "{}" },
      { stepIndex: 12, error: "z".repeat(3000), rawResponse: "{}" },
    ],
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

  it("formats non-Error debug IO failures with readable messages", async () => {
    const page = createMockPage();
    const mkdirSpy = jest.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw { reason: "mkdir object failure" };
    });
    const writeSpy = jest.spyOn(fs, "writeFileSync").mockImplementation(() => {
      return undefined;
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
      expect(errorSpy).toHaveBeenCalledWith(
        '[DebugIO] Failed to create directory "debug/test": {"reason":"mkdir object failure"}'
      );
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      mkdirSpy.mockRestore();
      writeSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("skips step artifact writes when step debug directory creation fails", async () => {
    const page = createMockPage();
    const mkdirSpy = jest
      .spyOn(fs, "mkdirSync")
      .mockImplementation((dirPath: fs.PathLike) => {
        if (String(dirPath).includes("step-0")) {
          throw new Error("step dir denied");
        }
        return undefined;
      });
    const writeSpy = jest.spyOn(fs, "writeFileSync").mockImplementation(() => {
      return undefined;
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
      const writtenFiles = writeSpy.mock.calls.map((call) => String(call[0]));
      expect(writtenFiles.some((path) => path.includes("step-0"))).toBe(false);
      expect(errorSpy).toHaveBeenCalled();
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

  it("truncates oversized structured-output diagnostics", async () => {
    const page = createMockPage();
    const hugeRaw = "x".repeat(120_000);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const ctx = createSchemaRetryCtx(hugeRaw);

    try {
      const result = await runAgentTask(ctx, createTaskState(page));
      expect(result.status).toBe(TaskStatus.COMPLETED);
      expect(ctx.schemaErrors).toBeDefined();
      const firstSchemaError = ctx.schemaErrors?.[0];
      expect(firstSchemaError).toBeDefined();
      expect(firstSchemaError?.error).toContain(
        "was skipped for validation diagnostics"
      );
      expect(firstSchemaError?.rawResponse).toContain("[truncated");
      expect(firstSchemaError?.rawResponse.length ?? 0).toBeLessThan(8_300);

      const structuredLogLine = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes("[LLM][StructuredOutput]"));
      expect(structuredLogLine).toBeDefined();
      expect(structuredLogLine).toContain("[truncated");
      expect(structuredLogLine).not.toContain(hugeRaw);

      const invokeStructuredMock = (
        ctx.llm as unknown as { invokeStructured: jest.Mock }
      ).invokeStructured;
      const secondCallMessages = invokeStructuredMock.mock.calls[1]?.[1] as Array<{
        role: string;
        content: unknown;
      }>;
      expect(Array.isArray(secondCallMessages)).toBe(true);
      const retryAssistantMessage = secondCallMessages
        .slice()
        .reverse()
        .find((message) => message.role === "assistant");
      const retryUserMessage = secondCallMessages
        .slice()
        .reverse()
        .find((message) => message.role === "user");

      expect(typeof retryAssistantMessage?.content).toBe("string");
      expect(typeof retryUserMessage?.content).toBe("string");
      expect(retryAssistantMessage?.content).toContain("[truncated");
      expect(retryUserMessage?.content).toContain(
        "was skipped for validation diagnostics"
      );
      expect(retryAssistantMessage?.content).not.toContain(hugeRaw);
      expect(retryUserMessage?.content).not.toContain(hugeRaw);
      expect((retryUserMessage?.content as string).length).toBeLessThan(4_500);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("formats structured-output retry failures with readable messages", async () => {
    const page = createMockPage();
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const ctx = createTransientStructuredFailureCtx();

    try {
      const result = await runAgentTask(ctx, createTaskState(page));
      expect(result.status).toBe(TaskStatus.COMPLETED);

      const retryLogLine = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes("[LLM][StructuredOutput] Retry error"));
      expect(retryLogLine).toBe(
        '[LLM][StructuredOutput] Retry error Retry Attempt 1/3: {"reason":"temporary llm failure"}'
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not crash when action fingerprint params contain circular values", async () => {
    const page = createMockPage();
    const ctx = createCircularParamsStepCtx();

    const result = await runAgentTask(ctx, createTaskState(page));
    expect(result.status).toBe(TaskStatus.COMPLETED);
    expect(result.output).toBe("final answer");
  });

  it("truncates schema-error summaries appended to retry context", async () => {
    const page = createMockPage();
    const ctx = createSchemaErrorSummaryCtx();

    await runAgentTask(ctx, createTaskState(page));

    const invokeStructuredMock = (
      ctx.llm as unknown as { invokeStructured: jest.Mock }
    ).invokeStructured;
    const firstCallMessages = invokeStructuredMock.mock.calls[0]?.[1] as Array<{
      role: string;
      content: unknown;
    }>;
    const schemaSummaryMessage = firstCallMessages.find(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.includes("Previous steps had schema validation errors")
    );

    expect(schemaSummaryMessage).toBeDefined();
    const summaryContent = schemaSummaryMessage?.content as string;
    expect(summaryContent).toContain("[truncated");
    expect(summaryContent.length).toBeLessThan(3_600);
  });

  it("caps schema-error history to avoid unbounded growth", async () => {
    const page = createMockPage();
    const ctx = createSchemaRetryCtx("not-json");
    ctx.schemaErrors = Array.from({ length: 20 }, (_, index) => ({
      stepIndex: 100 + index,
      error: `existing-error-${index}`,
      rawResponse: "{}",
    }));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      await runAgentTask(ctx, createTaskState(page));

      expect(ctx.schemaErrors).toHaveLength(20);
      expect(ctx.schemaErrors?.some((error) => error.stepIndex === 100)).toBe(
        false
      );
      expect(ctx.schemaErrors?.some((error) => error.stepIndex === 0)).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
