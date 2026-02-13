import { FrameContextManager } from "@/cdp/frame-context-manager";
import type { CDPClient, CDPSession } from "@/cdp/types";

class FakeSession implements CDPSession {
  public id = "session-1";
  public raw = undefined;
  public offEvents: string[] = [];
  private handlers = new Map<string, Set<(...payload: unknown[]) => void>>();

  async send<T = unknown>(method: string): Promise<T> {
    if (method === "Page.getFrameTree") {
      return {
        frameTree: {
          frame: {
            id: "root-frame",
            parentId: undefined,
            loaderId: "loader-1",
            name: "root",
            url: "https://example.com",
          },
          childFrames: [],
        },
      } as T;
    }
    if (
      method === "Page.enable" ||
      method === "Runtime.enable" ||
      method === "DOM.getFrameOwner"
    ) {
      return {} as T;
    }
    return {} as T;
  }

  on<TPayload extends unknown[]>(
    event: string,
    handler: (...payload: TPayload) => void
  ): void {
    const eventHandlers = this.handlers.get(event) ?? new Set();
    eventHandlers.add(handler as (...payload: unknown[]) => void);
    this.handlers.set(event, eventHandlers);
  }

  off<TPayload extends unknown[]>(
    event: string,
    handler: (...payload: TPayload) => void
  ): void {
    this.offEvents.push(event);
    const eventHandlers = this.handlers.get(event);
    eventHandlers?.delete(handler as (...payload: unknown[]) => void);
  }

  async detach(): Promise<void> {
    return;
  }
}

class FailingEnableSession extends FakeSession {
  async send<T = unknown>(method: string): Promise<T> {
    if (method === "Page.enable") {
      throw { reason: "page enable object failure" };
    }
    if (method === "Runtime.enable") {
      throw { reason: "runtime enable object failure" };
    }
    return super.send<T>(method);
  }
}

function createFakeClient(session: CDPSession): CDPClient {
  return {
    rootSession: session,
    createSession: async () => session,
    acquireSession: async () => session,
    dispose: async () => undefined,
  };
}

describe("FrameContextManager listener bookkeeping", () => {
  it("cleans up both page and runtime listeners on clear", async () => {
    const session = new FakeSession();
    const manager = new FrameContextManager(createFakeClient(session));

    await manager.ensureInitialized();
    manager.clear();

    expect(session.offEvents).toEqual(
      expect.arrayContaining([
        "Page.frameAttached",
        "Page.frameDetached",
        "Page.frameNavigated",
        "Runtime.executionContextCreated",
        "Runtime.executionContextDestroyed",
        "Runtime.executionContextsCleared",
      ])
    );
  });

  it("formats non-Error enable failures as readable messages", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const session = new FailingEnableSession();
      const manager = new FrameContextManager(createFakeClient(session));

      await manager.ensureInitialized();
      await Promise.resolve();

      expect(warnSpy).toHaveBeenCalledWith(
        '[FrameContext] Failed to enable Page domain: {"reason":"page enable object failure"}'
      );
      expect(warnSpy).toHaveBeenCalledWith(
        '[FrameContextManager] Failed to enable Runtime domain: {"reason":"runtime enable object failure"}'
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("cleans cached Playwright OOPIF detach handlers on clear", () => {
    const session = new FakeSession();
    const manager = new FrameContextManager(createFakeClient(session));
    const fakeFrame = {
      url: () => "https://example.com/iframe",
      parentFrame: () => null,
      name: () => "iframe",
      isDetached: () => false,
    };
    const detachHandler = jest.fn();

    (
      manager as unknown as {
        playwrightOopifCache: Map<unknown, unknown>;
      }
    ).playwrightOopifCache.set(fakeFrame, {
      frameId: "oopif-1",
      session,
      url: "https://example.com/iframe",
      playwrightFrame: fakeFrame,
      detachHandler,
    });

    manager.clear();

    expect(session.offEvents).toContain("Detached");
    expect(
      (
        manager as unknown as {
          playwrightOopifCache: Map<unknown, unknown>;
        }
      ).playwrightOopifCache.size
    ).toBe(0);
  });
});
