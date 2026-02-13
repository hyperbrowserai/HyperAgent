import { chromium } from "playwright-core";
import { Hyperbrowser } from "@hyperbrowser/sdk";

import { HyperbrowserProvider } from "@/browser-providers/hyperbrowser";

jest.mock("playwright-core", () => ({
  chromium: {
    connectOverCDP: jest.fn(),
  },
}));

jest.mock("@hyperbrowser/sdk", () => ({
  Hyperbrowser: jest.fn(),
}));

describe("HyperbrowserProvider lifecycle hardening", () => {
  const createSession = jest.fn();
  const stopSession = jest.fn();
  const connectOverCDP = jest.mocked(chromium.connectOverCDP);
  const HyperbrowserCtor = Hyperbrowser as unknown as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    createSession.mockReset();
    stopSession.mockReset();
    HyperbrowserCtor.mockImplementation(() => ({
      sessions: {
        create: createSession,
        stop: stopSession,
      },
    }));
  });

  it("stops created session when CDP connect fails during start", async () => {
    createSession.mockResolvedValue({
      id: "session-1",
      wsEndpoint: "ws://example",
      liveUrl: "https://live",
      sessionUrl: "https://session",
    });
    stopSession.mockResolvedValue(undefined);
    connectOverCDP.mockRejectedValue(new Error("cdp trap"));

    const provider = new HyperbrowserProvider();

    await expect(provider.start()).rejects.toThrow(
      "Failed to connect to Hyperbrowser session: cdp trap"
    );
    expect(stopSession).toHaveBeenCalledWith("session-1");
    expect(provider.getSession()).toBeNull();
  });

  it("reports cleanup diagnostics when start cleanup stop fails", async () => {
    createSession.mockResolvedValue({
      id: "session-1",
      wsEndpoint: "ws://example",
      liveUrl: "https://live",
      sessionUrl: "https://session",
    });
    connectOverCDP.mockRejectedValue(new Error("cdp trap"));
    stopSession.mockRejectedValue(new Error("stop trap"));

    const provider = new HyperbrowserProvider();

    await expect(provider.start()).rejects.toThrow(
      "Failed to connect to Hyperbrowser session: cdp trap; Failed to stop Hyperbrowser session session-1: stop trap"
    );
  });

  it("truncates oversized start diagnostics", async () => {
    createSession.mockResolvedValue({
      id: "session-1",
      wsEndpoint: "ws://example",
      liveUrl: "https://live",
      sessionUrl: "https://session",
    });
    connectOverCDP.mockRejectedValue(new Error("x".repeat(2_000)));
    stopSession.mockRejectedValue(new Error("x".repeat(2_000)));

    const provider = new HyperbrowserProvider();

    await expect(provider.start()).rejects.toThrow(/\[truncated/);
  });

  it("sanitizes control characters in start diagnostics", async () => {
    createSession.mockResolvedValue({
      id: "session-1",
      wsEndpoint: "ws://example",
      liveUrl: "https://live",
      sessionUrl: "https://session",
    });
    connectOverCDP.mockRejectedValue(new Error(`cdp\u0000\n${"x".repeat(2_000)}`));
    stopSession.mockRejectedValue(new Error(`stop\u0000\n${"x".repeat(2_000)}`));

    const provider = new HyperbrowserProvider();

    await provider
      .start()
      .then(() => {
        throw new Error("expected start to reject");
      })
      .catch((error) => {
        const message = String(error instanceof Error ? error.message : error);
        expect(message).toContain("[truncated");
        expect(message).not.toContain("\u0000");
        expect(message).not.toContain("\n");
      });
  });

  it("rejects missing websocket endpoints and cleans up session", async () => {
    createSession.mockResolvedValue({
      id: "session-1",
      wsEndpoint: "   ",
      liveUrl: "https://live",
      sessionUrl: "https://session",
    });
    stopSession.mockResolvedValue(undefined);

    const provider = new HyperbrowserProvider();

    await expect(provider.start()).rejects.toThrow(
      "Failed to connect to Hyperbrowser session: missing wsEndpoint"
    );
    expect(stopSession).toHaveBeenCalledWith("session-1");
  });

  it("close still stops session when browser close fails", async () => {
    const provider = new HyperbrowserProvider();
    provider.browser = {
      close: async () => {
        throw new Error("browser close trap");
      },
    } as never;
    provider.session = {
      id: "session-1",
    } as never;
    provider.hbClient = {
      sessions: {
        stop: stopSession,
      },
    } as never;
    stopSession.mockResolvedValue(undefined);

    await expect(provider.close()).rejects.toThrow(
      "Failed to close browser connection: browser close trap"
    );
    expect(stopSession).toHaveBeenCalledWith("session-1");
    expect(provider.getSession()).toBeNull();
  });

  it("close returns readable errors when session stop fails", async () => {
    const provider = new HyperbrowserProvider();
    provider.browser = {
      close: async () => undefined,
    } as never;
    provider.session = {
      id: "session-1",
    } as never;
    provider.hbClient = {
      sessions: {
        stop: stopSession,
      },
    } as never;
    stopSession.mockRejectedValue(new Error("stop trap"));

    await expect(provider.close()).rejects.toThrow(
      "Failed to stop Hyperbrowser session session-1: stop trap"
    );
  });

  it("truncates oversized close diagnostics", async () => {
    const provider = new HyperbrowserProvider();
    provider.browser = {
      close: async () => {
        throw new Error("x".repeat(2_000));
      },
    } as never;
    provider.session = {
      id: "session-1",
    } as never;
    provider.hbClient = {
      sessions: {
        stop: stopSession,
      },
    } as never;
    stopSession.mockRejectedValue(new Error("x".repeat(2_000)));

    await expect(provider.close()).rejects.toThrow(/\[truncated/);
  });

  it("sanitizes control characters in close diagnostics", async () => {
    const provider = new HyperbrowserProvider();
    provider.browser = {
      close: async () => {
        throw new Error(`browser\u0000\n${"x".repeat(2_000)}`);
      },
    } as never;
    provider.session = {
      id: "session-1",
    } as never;
    provider.hbClient = {
      sessions: {
        stop: stopSession,
      },
    } as never;
    stopSession.mockRejectedValue(new Error(`stop\u0000\n${"x".repeat(2_000)}`));

    await provider
      .close()
      .then(() => {
        throw new Error("expected close to reject");
      })
      .catch((error) => {
        const message = String(error instanceof Error ? error.message : error);
        expect(message).toContain("[truncated");
        expect(message).not.toContain("\u0000");
        expect(message).not.toContain("\n");
      });
  });
});
