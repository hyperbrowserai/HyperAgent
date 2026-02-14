import { FrameContextManager } from "@/cdp/frame-context-manager";
import type { CDPClient, CDPSession } from "@/cdp/types";

class FakeSession implements CDPSession {
  public id = "session-1";
  public raw = undefined;
  public offEvents: string[] = [];
  public onEvents: string[] = [];
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
    this.onEvents.push(event);
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

  emit(event: string, ...payload: unknown[]): void {
    const eventHandlers = this.handlers.get(event);
    if (!eventHandlers) {
      return;
    }
    for (const handler of eventHandlers) {
      handler(...payload);
    }
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

class OversizedFailingEnableSession extends FakeSession {
  async send<T = unknown>(method: string): Promise<T> {
    if (method === "Page.enable") {
      throw new Error(`page\u0000\n${"x".repeat(10_000)}`);
    }
    if (method === "Runtime.enable") {
      throw new Error(`runtime\u0000\n${"y".repeat(10_000)}`);
    }
    return super.send<T>(method);
  }
}

class NoisyFrameTreeSession extends FakeSession {
  async send<T = unknown>(method: string): Promise<T> {
    if (method === "Page.getFrameTree") {
      return {
        frameTree: {
          frame: {
            id: "root-frame",
            parentId: undefined,
            loaderId: "loader-1",
            name: "root\u0000\nframe",
            url: "https://example.com/\u0000root\nframe",
          },
          childFrames: [],
        },
      } as T;
    }
    return super.send(method);
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

function createFakeClientWithPage(
  session: CDPSession,
  page: unknown
): CDPClient {
  return {
    ...createFakeClient(session),
    getPage: () => page,
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

  it("sanitizes and truncates oversized enable diagnostics", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const session = new OversizedFailingEnableSession();
      const manager = new FrameContextManager(createFakeClient(session));

      await manager.ensureInitialized();
      await Promise.resolve();

      const pageEnableWarning = warnSpy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes("Failed to enable Page domain"));
      const runtimeEnableWarning = warnSpy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes("Failed to enable Runtime domain"));

      expect(pageEnableWarning).toBeDefined();
      expect(runtimeEnableWarning).toBeDefined();
      expect(pageEnableWarning).toContain("[truncated");
      expect(runtimeEnableWarning).toContain("[truncated");
      expect(pageEnableWarning).not.toContain("\u0000");
      expect(runtimeEnableWarning).not.toContain("\u0000");
      expect(pageEnableWarning).not.toContain("\n");
      expect(runtimeEnableWarning).not.toContain("\n");
      expect(pageEnableWarning?.length ?? 0).toBeLessThan(700);
      expect(runtimeEnableWarning?.length ?? 0).toBeLessThan(700);
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

  it("can reinitialize listeners after clear", async () => {
    const session = new FakeSession();
    const manager = new FrameContextManager(createFakeClient(session));

    await manager.ensureInitialized();
    const firstAttachedRegistrations = session.onEvents.filter(
      (event) => event === "Page.frameAttached"
    ).length;
    expect(firstAttachedRegistrations).toBe(1);

    manager.clear();
    await manager.ensureInitialized();

    const secondAttachedRegistrations = session.onEvents.filter(
      (event) => event === "Page.frameAttached"
    ).length;
    expect(secondAttachedRegistrations).toBe(2);
  });

  it("sanitizes control characters in captured frame tree metadata", async () => {
    const session = new NoisyFrameTreeSession();
    const manager = new FrameContextManager(createFakeClient(session));

    await manager.ensureInitialized();

    const rootFrame = manager.getFrame("root-frame");
    expect(rootFrame?.url).toBe("https://example.com/ root frame");
    expect(rootFrame?.name).toBe("root frame");
  });

  it("sanitizes control characters in frameNavigated metadata updates", async () => {
    const session = new FakeSession();
    const manager = new FrameContextManager(createFakeClient(session));

    await manager.ensureInitialized();

    session.emit("Page.frameNavigated", {
      frame: {
        id: "root-frame",
        parentId: undefined,
        loaderId: "loader-2",
        name: "updated\u0000\nname",
        url: "https://example.com/\u0000updated\nframe",
      },
    });

    const rootFrame = manager.getFrame("root-frame");
    expect(rootFrame?.url).toBe("https://example.com/ updated frame");
    expect(rootFrame?.name).toBe("updated name");
  });

  it("captureOOPIFs tolerates trap-prone frame metadata on same-origin frames", async () => {
    const session = new FakeSession();
    const mainFrame = {
      url: () => "https://example.com",
      parentFrame: () => null,
      name: () => "main",
      isDetached: () => false,
    };
    const trappedFrame = {
      url: () => {
        throw new Error("frame url trap");
      },
      parentFrame: () => {
        throw new Error("parent frame trap");
      },
      name: () => {
        throw new Error("frame name trap");
      },
      isDetached: () => false,
    };
    const page = {
      context: () => ({
        newCDPSession: jest.fn().mockRejectedValue(new Error("same origin frame")),
      }),
      frames: () => [mainFrame, trappedFrame],
      mainFrame: () => mainFrame,
    };

    const manager = new FrameContextManager(
      createFakeClientWithPage(session, page)
    );

    await expect(manager.captureOOPIFs(1)).resolves.toBeUndefined();
  });

  it("captureOOPIFs keeps cached records when frame metadata getters trap", async () => {
    const session = new FakeSession();
    const mainFrame = {
      url: () => "https://example.com",
      parentFrame: () => null,
      name: () => "main",
      isDetached: () => false,
    };
    const trappedFrame = {
      url: () => {
        throw new Error("frame url trap");
      },
      parentFrame: () => null,
      name: () => {
        throw new Error("frame name trap");
      },
      isDetached: () => false,
    };
    const page = {
      context: () => ({
        newCDPSession: jest.fn(),
      }),
      frames: () => [mainFrame, trappedFrame],
      mainFrame: () => mainFrame,
    };

    const manager = new FrameContextManager(
      createFakeClientWithPage(session, page)
    );
    (
      manager as unknown as {
        playwrightOopifCache: Map<unknown, unknown>;
      }
    ).playwrightOopifCache.set(trappedFrame, {
      frameId: "cached-oopif",
      session,
      url: "https://cached.example",
      name: "cached-name",
      parentFrameUrl: null,
      playwrightFrame: trappedFrame,
    });

    await expect(manager.captureOOPIFs(1)).resolves.toBeUndefined();
    const cached = (
      manager as unknown as {
        playwrightOopifCache: Map<
          unknown,
          { url?: string; name?: string; frameId?: string }
        >;
      }
    ).playwrightOopifCache.get(trappedFrame);
    expect(cached?.frameId).toBe("cached-oopif");
    expect(cached?.url).toBe("about:blank");
    expect(cached?.name).toBeUndefined();
  });
});
