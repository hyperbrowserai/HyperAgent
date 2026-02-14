import type { Page } from "playwright-core";
import { HyperAgent } from "@/agent";
import type { HyperAgentLLM } from "@/llm/types";
import { TaskStatus } from "@/types";

jest.mock("@/agent/shared/find-element", () => ({
  findElementWithInstruction: jest.fn(),
}));

jest.mock("@/agent/actions/shared/perform-action", () => ({
  performAction: jest.fn(),
}));

jest.mock("@/agent/shared/runtime-context", () => ({
  initializeRuntimeContext: jest.fn(),
}));

jest.mock("@/utils/waitForSettledDOM", () => ({
  waitForSettledDOM: jest.fn(),
}));

jest.mock("@/utils/debugWriter", () => ({
  writePerformDebug: jest.fn(),
}));

jest.mock("@/context-providers/a11y-dom/dom-cache", () => ({
  markDomSnapshotDirty: jest.fn(),
}));

const { findElementWithInstruction } = jest.requireMock(
  "@/agent/shared/find-element"
) as {
  findElementWithInstruction: jest.Mock;
};

const { performAction } = jest.requireMock(
  "@/agent/actions/shared/perform-action"
) as {
  performAction: jest.Mock;
};

const { initializeRuntimeContext } = jest.requireMock(
  "@/agent/shared/runtime-context"
) as {
  initializeRuntimeContext: jest.Mock;
};

const { waitForSettledDOM } = jest.requireMock(
  "@/utils/waitForSettledDOM"
) as {
  waitForSettledDOM: jest.Mock;
};

const { writePerformDebug } = jest.requireMock(
  "@/utils/debugWriter"
) as {
  writePerformDebug: jest.Mock;
};

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

describe("HyperAgent.executeSingleAction retry options", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    findElementWithInstruction.mockResolvedValue({
      success: true,
      element: {
        elementId: "0-1",
        method: "click",
        arguments: [],
        confidence: 1,
        description: "button",
      },
      domState: {
        elements: new Map([["0-1", { role: "button" }]]),
        domState: "dom",
        xpathMap: { "0-1": "//button[1]" },
        backendNodeMap: {},
      },
      elementMap: new Map([["0-1", { role: "button" }]]),
      llmResponse: {
        rawText: "{}",
        parsed: {},
      },
    });
    initializeRuntimeContext.mockResolvedValue({
      cdpClient: {},
      frameContextManager: {},
    });
    performAction.mockResolvedValue({
      success: true,
      message: "ok",
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
    writePerformDebug.mockResolvedValue(undefined);
  });

  it("passes maxElementRetries and retryDelayMs to findElementWithInstruction", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: false,
      cdpActions: false,
    });
    const page = {
      url: () => "https://example.com",
    } as unknown as Page;

    await agent.executeSingleAction("click login", page, {
      maxElementRetries: 7,
      retryDelayMs: 42,
      maxContextSwitchRetries: 2,
    });

    expect(findElementWithInstruction).toHaveBeenCalledWith(
      "click login",
      page,
      expect.any(Object),
      expect.objectContaining({
        maxRetries: 7,
        retryDelayMs: 42,
      })
    );
  });

  it("uses deprecated maxSteps as fallback for single-action retries", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: false,
      cdpActions: false,
    });
    const page = {
      url: () => "https://example.com",
    } as unknown as Page;
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await agent.executeSingleAction("click login", page, {
        maxSteps: 4,
        retryDelayMs: 33,
      });

      expect(findElementWithInstruction).toHaveBeenCalledWith(
        "click login",
        page,
        expect.any(Object),
        expect.objectContaining({
          maxRetries: 4,
          retryDelayMs: 33,
        })
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("prefers maxElementRetries over deprecated maxSteps when both are set", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: false,
      cdpActions: false,
    });
    const page = {
      url: () => "https://example.com",
    } as unknown as Page;

    await agent.executeSingleAction("click login", page, {
      maxElementRetries: 6,
      maxSteps: 2,
    });

    expect(findElementWithInstruction).toHaveBeenCalledWith(
      "click login",
      page,
      expect.any(Object),
      expect.objectContaining({
        maxRetries: 6,
      })
    );
  });

  it("warns once when deprecated maxSteps perform option is used", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: false,
      cdpActions: false,
    });
    const page = {
      url: () => "https://example.com",
    } as unknown as Page;
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await agent.executeSingleAction("click login", page, {
        maxSteps: 2,
      });
      await agent.executeSingleAction("click continue", page, {
        maxSteps: 3,
      });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("perform({ maxSteps }) is deprecated")
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn about maxSteps deprecation when maxElementRetries is used", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: false,
      cdpActions: false,
    });
    const page = {
      url: () => "https://example.com",
    } as unknown as Page;
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await agent.executeSingleAction("click login", page, {
        maxElementRetries: 4,
      });

      const deprecationWarnings = warnSpy.mock.calls.filter((call) =>
        String(call[0] ?? "").includes("perform({ maxSteps }) is deprecated")
      );
      expect(deprecationWarnings).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("formats non-Error execution failures with readable messages", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: false,
      cdpActions: false,
    });
    const page = {
      url: () => "https://example.com",
    } as unknown as Page;
    performAction.mockRejectedValue({ reason: "perform crashed" });

    await expect(
      agent.executeSingleAction("click login", page, {
        maxElementRetries: 1,
      })
    ).rejects.toThrow(
      'Failed to execute action: {"reason":"perform crashed"}'
    );
  });

  it("truncates oversized execution failures with bounded diagnostics", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: false,
      cdpActions: false,
    });
    const page = {
      url: () => "https://example.com",
    } as unknown as Page;
    performAction.mockRejectedValue(new Error("x".repeat(2_000)));

    await expect(
      agent.executeSingleAction("click login", page, {
        maxElementRetries: 1,
      })
    ).rejects.toThrow(/\[truncated/);
  });

  it("formats non-Error failure payloads written to perform debug artifacts", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: true,
      cdpActions: false,
    });
    const page = {
      url: () => "https://example.com",
      screenshot: jest.fn().mockResolvedValue(Buffer.from("screenshot")),
    } as unknown as Page;
    performAction.mockRejectedValue({ reason: "perform crashed" });
    writePerformDebug.mockResolvedValue(undefined);
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(
        agent.executeSingleAction("click login", page, {
          maxElementRetries: 1,
        })
      ).rejects.toThrow(
        'Failed to execute action: {"reason":"perform crashed"}'
      );

      expect(writePerformDebug).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            message: '{"reason":"perform crashed"}',
          }),
        }),
        "debug/perform"
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("truncates oversized failure payloads written to perform debug artifacts", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: true,
      cdpActions: false,
    });
    const page = {
      url: () => "https://example.com",
      screenshot: jest.fn().mockResolvedValue(Buffer.from("screenshot")),
    } as unknown as Page;
    performAction.mockRejectedValue(new Error("x".repeat(2_000)));
    writePerformDebug.mockResolvedValue(undefined);
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(
        agent.executeSingleAction("click login", page, {
          maxElementRetries: 1,
        })
      ).rejects.toThrow(/\[truncated/);

      expect(writePerformDebug).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            message: expect.stringContaining("[truncated"),
          }),
        }),
        "debug/perform"
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("formats non-Error perform debug writer failures", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: true,
      cdpActions: false,
    });
    const page = {
      url: () => "https://example.com",
      screenshot: jest.fn().mockResolvedValue(Buffer.from("screenshot")),
    } as unknown as Page;
    writePerformDebug.mockRejectedValue({ reason: "debug writer crashed" });
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      const result = await agent.executeSingleAction("click login", page, {
        maxElementRetries: 1,
      });

      expect(result.status).toBe(TaskStatus.COMPLETED);
      expect(errorSpy).toHaveBeenCalledWith(
        '[perform] Failed to write debug data: {"reason":"debug writer crashed"}'
      );
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("truncates oversized perform debug writer diagnostics", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: true,
      cdpActions: false,
    });
    const page = {
      url: () => "https://example.com",
      screenshot: jest.fn().mockResolvedValue(Buffer.from("screenshot")),
    } as unknown as Page;
    writePerformDebug.mockRejectedValue(new Error("x".repeat(2_000)));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      const result = await agent.executeSingleAction("click login", page, {
        maxElementRetries: 1,
      });

      expect(result.status).toBe(TaskStatus.COMPLETED);
      const errorMessage = String(errorSpy.mock.calls[0]?.[0] ?? "");
      expect(errorMessage).toContain("[truncated");
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("preserves not-found diagnostics when page.url getter throws in debug mode", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: true,
      cdpActions: false,
    });
    const page = {
      url: () => {
        throw new Error("url trap");
      },
      screenshot: jest.fn().mockResolvedValue(Buffer.from("screenshot")),
    } as unknown as Page;
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    findElementWithInstruction.mockResolvedValueOnce({
      success: false,
      domState: {
        elements: new Map(),
        domState: "dom",
        xpathMap: {},
        backendNodeMap: {},
      },
      elementMap: new Map(),
      llmResponse: {
        rawText: "{}",
        parsed: {},
      },
    });

    try {
      await expect(
        agent.executeSingleAction("click login", page, {
          maxElementRetries: 1,
        })
      ).rejects.toThrow("No elements found for instruction");

      expect(writePerformDebug).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "about:blank",
        }),
        "debug/perform"
      );
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("sanitizes control characters in debug URL metadata", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: true,
      cdpActions: false,
    });
    const page = {
      url: () => "https://example.com/\u0000debug\npath",
      screenshot: jest.fn().mockResolvedValue(Buffer.from("screenshot")),
    } as unknown as Page;
    performAction.mockRejectedValueOnce({ reason: "perform crashed" });
    writePerformDebug.mockResolvedValue(undefined);
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        agent.executeSingleAction("click login", page, {
          maxElementRetries: 1,
        })
      ).rejects.toThrow('Failed to execute action: {"reason":"perform crashed"}');

      expect(writePerformDebug).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://example.com/ debug path",
        }),
        "debug/perform"
      );
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("continues debug-data writes when screenshot accessor traps throw", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: true,
      cdpActions: false,
    });
    const page = {
      url: () => "https://example.com",
      get screenshot(): never {
        throw new Error("screenshot trap");
      },
    } as unknown as Page;
    performAction.mockRejectedValueOnce(new Error("perform failed"));
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(
        agent.executeSingleAction("click login", page, {
          maxElementRetries: 1,
        })
      ).rejects.toThrow("perform failed");

      expect(writePerformDebug).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
        }),
        "debug/perform"
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("keeps element-not-found errors readable when page.url getter traps", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: true,
      cdpActions: false,
    });
    findElementWithInstruction.mockResolvedValueOnce({
      success: false,
      domState: {
        elements: new Map(),
        domState: "dom",
        xpathMap: {},
        backendNodeMap: {},
      },
      elementMap: new Map(),
      llmResponse: {
        rawText: "{}",
        parsed: {},
      },
    });
    const page = {
      url: () => {
        throw new Error("url trap");
      },
      screenshot: jest.fn().mockResolvedValue(Buffer.from("screenshot")),
    } as unknown as Page;
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(
        agent.executeSingleAction("click missing", page, {
          maxElementRetries: 1,
        })
      ).rejects.toThrow("No elements found for instruction");
      expect(writePerformDebug).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "about:blank",
        }),
        "debug/perform"
      );
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("continues debug writing when screenshot accessor traps throw", async () => {
    const agent = new HyperAgent({
      llm: createMockLLM(),
      debug: true,
      cdpActions: false,
    });
    performAction.mockRejectedValueOnce({ reason: "perform crashed" });
    writePerformDebug.mockResolvedValue(undefined);
    const page = {
      url: () => "https://example.com",
      get screenshot(): unknown {
        throw new Error("screenshot trap");
      },
    } as unknown as Page;
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(
        agent.executeSingleAction("click login", page, {
          maxElementRetries: 1,
        })
      ).rejects.toThrow('Failed to execute action: {"reason":"perform crashed"}');

      expect(writePerformDebug).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          screenshot: undefined,
        }),
        "debug/perform"
      );
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
