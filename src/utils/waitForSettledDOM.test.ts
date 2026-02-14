import {
  waitForSettledDOM,
  type WaitForSettledOptions,
} from "@/utils/waitForSettledDOM";
import type { CDPClient, CDPSession } from "@/cdp";

jest.mock("@/cdp", () => ({
  getCDPClient: jest.fn(),
  getOrCreateFrameContextManager: jest.fn(),
}));

jest.mock("@/debug/options", () => ({
  getDebugOptions: jest.fn(),
}));

const { getCDPClient, getOrCreateFrameContextManager } = jest.requireMock(
  "@/cdp"
) as {
  getCDPClient: jest.Mock;
  getOrCreateFrameContextManager: jest.Mock;
};
const { getDebugOptions } = jest.requireMock("@/debug/options") as {
  getDebugOptions: jest.Mock;
};

type EventHandler = (...args: unknown[]) => void;

function createSessionWithEvents(options?: {
  throwOnOnEvent?: string;
  throwOnOffEvent?: string;
  onErrorMessage?: string;
  offErrorMessage?: string;
  onErrorValue?: unknown;
  offErrorValue?: unknown;
}): {
  session: CDPSession;
  emit: (event: string, payload: unknown) => void;
} {
  const handlers = new Map<string, Set<EventHandler>>();
  const session: CDPSession = {
    send: async <T = unknown>(): Promise<T> => ({} as T),
    on: <TPayload extends unknown[]>(
      event: string,
      handler: (...payload: TPayload) => void
    ) => {
      if (options?.throwOnOnEvent === event) {
        if (typeof options.onErrorValue !== "undefined") {
          throw options.onErrorValue;
        }
        throw new Error(options.onErrorMessage ?? "listener registration failed");
      }
      const eventHandler = handler as EventHandler;
      const existing = handlers.get(event);
      if (existing) {
        existing.add(eventHandler);
      } else {
        handlers.set(event, new Set([eventHandler]));
      }
    },
    off: <TPayload extends unknown[]>(
      event: string,
      handler: (...payload: TPayload) => void
    ) => {
      if (options?.throwOnOffEvent === event) {
        if (typeof options.offErrorValue !== "undefined") {
          throw options.offErrorValue;
        }
        throw new Error(options.offErrorMessage ?? "listener detach failed");
      }
      handlers.get(event)?.delete(handler as EventHandler);
    },
    detach: async () => undefined,
    id: "session-1",
  };

  const emit = (event: string, payload: unknown): void => {
    handlers.get(event)?.forEach((handler) => {
      handler(payload);
    });
  };

  return { session, emit };
}

describe("waitForSettledDOM diagnostics", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    getDebugOptions.mockReturnValue({
      enabled: true,
      traceWait: true,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("sanitizes and truncates stalled-request warning diagnostics", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const { session, emit } = createSessionWithEvents();
    const cdpClient: CDPClient = {
      rootSession: session,
      createSession: async () => session,
      acquireSession: async () => session,
      dispose: async () => undefined,
    };
    getCDPClient.mockResolvedValue(cdpClient);
    getOrCreateFrameContextManager.mockReturnValue({
      setDebug: jest.fn(),
    });

    const page = {
      context: () => ({}),
    } as never;

    try {
      const waitPromise = waitForSettledDOM(page, 5_000);
      await Promise.resolve();
      await Promise.resolve();

      emit("Network.requestWillBeSent", {
        requestId: `req\u0000\n${"x".repeat(600)}`,
        type: "Document",
        request: {
          url: `https://example.com/path\u0000\n${"y".repeat(2_000)}`,
        },
      });

      await jest.advanceTimersByTimeAsync(3_100);
      const stats = await waitPromise;

      const warning = String(warnSpy.mock.calls[0]?.[0] ?? "");
      expect(warning).toContain("[truncated");
      expect(warning).not.toContain("\u0000");
      expect(warning).not.toContain("\n");
      expect(warning.length).toBeLessThan(900);
      expect(stats.forcedDrops).toBe(1);
      expect(stats.requestsSeen).toBe(1);
      expect(stats.peakInflight).toBe(1);
      expect(stats.resolvedByTimeout).toBe(false);
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("reports timeout-driven completion when requests remain inflight", async () => {
    const { session, emit } = createSessionWithEvents();
    const cdpClient: CDPClient = {
      rootSession: session,
      createSession: async () => session,
      acquireSession: async () => session,
      dispose: async () => undefined,
    };
    getCDPClient.mockResolvedValue(cdpClient);
    getOrCreateFrameContextManager.mockReturnValue({
      setDebug: jest.fn(),
    });
    getDebugOptions.mockReturnValue({
      enabled: false,
      traceWait: false,
    });

    const page = {
      context: () => ({}),
    } as never;

    const waitPromise = waitForSettledDOM(page, 600);
    await Promise.resolve();
    await Promise.resolve();

    emit("Network.requestWillBeSent", {
      requestId: "req-1",
      type: "Document",
      request: { url: "https://example.com/slow" },
    });

    await jest.advanceTimersByTimeAsync(700);
    const stats = await waitPromise;

    expect(stats.resolvedByTimeout).toBe(true);
    expect(stats.forcedDrops).toBe(0);
    expect(stats.requestsSeen).toBe(1);
    expect(stats.peakInflight).toBe(1);
  });

  it("normalizes invalid timeout values instead of timing out immediately", async () => {
    const { session } = createSessionWithEvents();
    const cdpClient: CDPClient = {
      rootSession: session,
      createSession: async () => session,
      acquireSession: async () => session,
      dispose: async () => undefined,
    };
    getCDPClient.mockResolvedValue(cdpClient);
    getOrCreateFrameContextManager.mockReturnValue({
      setDebug: jest.fn(),
    });
    getDebugOptions.mockReturnValue({
      enabled: false,
      traceWait: false,
    });

    const page = {
      context: () => ({}),
    } as never;

    const waitPromise = waitForSettledDOM(page, Number.NaN as unknown as number);
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(600);
    const stats = await waitPromise;

    expect(stats.resolvedByTimeout).toBe(false);
    expect(stats.requestsSeen).toBe(0);
    expect(stats.forcedDrops).toBe(0);
  });

  it("applies frame filtering option when provided", async () => {
    const { session } = createSessionWithEvents();
    const cdpClient: CDPClient = {
      rootSession: session,
      createSession: async () => session,
      acquireSession: async () => session,
      dispose: async () => undefined,
    };
    const setFrameFilteringEnabled = jest.fn();
    getCDPClient.mockResolvedValue(cdpClient);
    getOrCreateFrameContextManager.mockReturnValue({
      setDebug: jest.fn(),
      setFrameFilteringEnabled,
    });
    getDebugOptions.mockReturnValue({
      enabled: false,
      traceWait: false,
    });

    const page = {
      context: () => ({}),
    } as never;

    const waitPromise = waitForSettledDOM(page, 600, {
      filterAdTrackingFrames: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(700);
    await waitPromise;

    expect(setFrameFilteringEnabled).toHaveBeenCalledWith(false);
  });

  it("continues when frame-filter configuration throws", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { session } = createSessionWithEvents();
    const cdpClient: CDPClient = {
      rootSession: session,
      createSession: async () => session,
      acquireSession: async () => session,
      dispose: async () => undefined,
    };
    getCDPClient.mockResolvedValue(cdpClient);
    getOrCreateFrameContextManager.mockReturnValue({
      setDebug: jest.fn(),
      setFrameFilteringEnabled: jest.fn(() => {
        throw new Error(`filter\u0000\n${"x".repeat(2_000)}`);
      }),
    });
    getDebugOptions.mockReturnValue({
      enabled: false,
      traceWait: false,
    });

    const page = {
      context: () => ({}),
    } as never;

    try {
      const waitPromise = waitForSettledDOM(page, 600, {
        filterAdTrackingFrames: false,
      });
      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(700);
      const stats = await waitPromise;

      expect(stats.resolvedByTimeout).toBe(false);
      const warning = String(
        warnSpy.mock.calls.find((call) =>
          String(call[0] ?? "").includes("configure frame filtering")
        )?.[0] ?? ""
      );
      expect(warning).toContain("[truncated");
      expect(warning).not.toContain("\u0000");
      expect(warning).not.toContain("\n");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("ignores trap-prone frame-filter option getters", async () => {
    const { session } = createSessionWithEvents();
    const cdpClient: CDPClient = {
      rootSession: session,
      createSession: async () => session,
      acquireSession: async () => session,
      dispose: async () => undefined,
    };
    const setFrameFilteringEnabled = jest.fn();
    getCDPClient.mockResolvedValue(cdpClient);
    getOrCreateFrameContextManager.mockReturnValue({
      setDebug: jest.fn(),
      setFrameFilteringEnabled,
    });
    getDebugOptions.mockReturnValue({
      enabled: false,
      traceWait: false,
    });

    const trappedOptions = new Proxy(
      {},
      {
        get: (_target, prop: string | symbol) => {
          if (prop === "filterAdTrackingFrames") {
            throw new Error("frame-filter option trap");
          }
          return undefined;
        },
      }
    ) as WaitForSettledOptions;

    const page = {
      context: () => ({}),
    } as never;

    const waitPromise = waitForSettledDOM(page, 600, trappedOptions);
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(700);
    const stats = await waitPromise;

    expect(stats.resolvedByTimeout).toBe(false);
    expect(setFrameFilteringEnabled).not.toHaveBeenCalled();
  });

  it("falls back to timeout when network listener registration fails", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { session } = createSessionWithEvents({
      throwOnOnEvent: "Network.requestWillBeSent",
      onErrorMessage: `attach\u0000\n${"x".repeat(10_000)}`,
    });
    const cdpClient: CDPClient = {
      rootSession: session,
      createSession: async () => session,
      acquireSession: async () => session,
      dispose: async () => undefined,
    };
    getCDPClient.mockResolvedValue(cdpClient);
    getOrCreateFrameContextManager.mockReturnValue({
      setDebug: jest.fn(),
    });
    getDebugOptions.mockReturnValue({
      enabled: false,
      traceWait: false,
    });

    const page = {
      context: () => ({}),
    } as never;

    try {
      const waitPromise = waitForSettledDOM(page, 700);
      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(800);
      const stats = await waitPromise;

      const attachWarning = String(warnSpy.mock.calls[0]?.[0] ?? "");
      const fallbackWarning = String(warnSpy.mock.calls[1]?.[0] ?? "");
      expect(attachWarning).toContain("[truncated");
      expect(attachWarning).not.toContain("\u0000");
      expect(attachWarning).not.toContain("\n");
      expect(fallbackWarning).toContain("falling back to timeout-based settle");
      expect(stats.resolvedByTimeout).toBe(true);
      expect(stats.requestsSeen).toBe(0);
      expect(stats.peakInflight).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("falls back to timeout when listener method getter traps", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { session } = createSessionWithEvents();
    const trappedSession = new Proxy(session, {
      get: (target, prop, receiver) => {
        if (prop === "on") {
          throw new Error(`on getter\u0000\n${"x".repeat(10_000)}`);
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as CDPSession;
    const cdpClient: CDPClient = {
      rootSession: trappedSession,
      createSession: async () => trappedSession,
      acquireSession: async () => trappedSession,
      dispose: async () => undefined,
    };
    getCDPClient.mockResolvedValue(cdpClient);
    getOrCreateFrameContextManager.mockReturnValue({
      setDebug: jest.fn(),
    });
    getDebugOptions.mockReturnValue({
      enabled: false,
      traceWait: false,
    });

    const page = {
      context: () => ({}),
    } as never;

    try {
      const waitPromise = waitForSettledDOM(page, 700);
      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(800);
      const stats = await waitPromise;

      const attachWarning = String(warnSpy.mock.calls[0]?.[0] ?? "");
      const fallbackWarning = String(
        warnSpy.mock.calls.find((call) =>
          String(call[0] ?? "").includes("falling back to timeout-based settle")
        )?.[0] ?? ""
      );
      expect(attachWarning).toContain("[truncated");
      expect(attachWarning).not.toContain("\u0000");
      expect(attachWarning).not.toContain("\n");
      expect(fallbackWarning).toContain("falling back to timeout-based settle");
      expect(stats.resolvedByTimeout).toBe(true);
      expect(stats.requestsSeen).toBe(0);
      expect(stats.peakInflight).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("formats non-Error listener registration diagnostics deterministically", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { session } = createSessionWithEvents({
      throwOnOnEvent: "Network.requestWillBeSent",
      onErrorValue: { reason: "attach object failure" },
    });
    const cdpClient: CDPClient = {
      rootSession: session,
      createSession: async () => session,
      acquireSession: async () => session,
      dispose: async () => undefined,
    };
    getCDPClient.mockResolvedValue(cdpClient);
    getOrCreateFrameContextManager.mockReturnValue({
      setDebug: jest.fn(),
    });
    getDebugOptions.mockReturnValue({
      enabled: false,
      traceWait: false,
    });

    const page = {
      context: () => ({}),
    } as never;

    try {
      const waitPromise = waitForSettledDOM(page, 700);
      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(800);
      await waitPromise;

      const attachWarning = String(warnSpy.mock.calls[0]?.[0] ?? "");
      expect(attachWarning).toContain('{"reason":"attach object failure"}');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("sanitizes and truncates listener detach getter diagnostics", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { session } = createSessionWithEvents();
    const trappedSession = new Proxy(session, {
      get: (target, prop, receiver) => {
        if (prop === "off") {
          throw new Error(`off getter\u0000\n${"x".repeat(10_000)}`);
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as CDPSession;
    const cdpClient: CDPClient = {
      rootSession: trappedSession,
      createSession: async () => trappedSession,
      acquireSession: async () => trappedSession,
      dispose: async () => undefined,
    };
    getCDPClient.mockResolvedValue(cdpClient);
    getOrCreateFrameContextManager.mockReturnValue({
      setDebug: jest.fn(),
    });
    getDebugOptions.mockReturnValue({
      enabled: false,
      traceWait: false,
    });

    const page = {
      context: () => ({}),
    } as never;

    try {
      const waitPromise = waitForSettledDOM(page, 2000);
      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(600);
      const stats = await waitPromise;

      const detachWarning = String(
        warnSpy.mock.calls.find((call) =>
          String(call[0] ?? "").includes("Failed to detach listener")
        )?.[0] ?? ""
      );
      expect(detachWarning).toContain("[truncated");
      expect(detachWarning).not.toContain("\u0000");
      expect(detachWarning).not.toContain("\n");
      expect(stats.resolvedByTimeout).toBe(false);
      expect(stats.requestsSeen).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("sanitizes and truncates listener detach diagnostics", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { session } = createSessionWithEvents({
      throwOnOffEvent: "Network.loadingFinished",
      offErrorMessage: `detach\u0000\n${"x".repeat(10_000)}`,
    });
    const cdpClient: CDPClient = {
      rootSession: session,
      createSession: async () => session,
      acquireSession: async () => session,
      dispose: async () => undefined,
    };
    getCDPClient.mockResolvedValue(cdpClient);
    getOrCreateFrameContextManager.mockReturnValue({
      setDebug: jest.fn(),
    });
    getDebugOptions.mockReturnValue({
      enabled: false,
      traceWait: false,
    });

    const page = {
      context: () => ({}),
    } as never;

    try {
      const waitPromise = waitForSettledDOM(page, 2000);
      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(600);
      const stats = await waitPromise;

      const detachWarning = String(warnSpy.mock.calls[0]?.[0] ?? "");
      expect(detachWarning).toContain("Failed to detach listener");
      expect(detachWarning).toContain("[truncated");
      expect(detachWarning).not.toContain("\u0000");
      expect(detachWarning).not.toContain("\n");
      expect(stats.resolvedByTimeout).toBe(false);
      expect(stats.requestsSeen).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
