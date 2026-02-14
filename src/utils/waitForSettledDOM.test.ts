import { waitForSettledDOM } from "@/utils/waitForSettledDOM";
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

function createSessionWithEvents(): {
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
});
