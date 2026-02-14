import type { Page } from "playwright-core";
import { getA11yDOM } from "@/context-providers/a11y-dom";
import { domSnapshotCache } from "@/context-providers/a11y-dom/dom-cache";

const getCDPClientMock = jest.fn();
const getOrCreateFrameContextManagerMock = jest.fn();
const buildBackendIdMapsMock = jest.fn();

jest.mock("@/cdp", () => ({
  getCDPClient: (...args: unknown[]) => getCDPClientMock(...args),
  getOrCreateFrameContextManager: (...args: unknown[]) =>
    getOrCreateFrameContextManagerMock(...args),
}));

jest.mock("./build-maps", () => ({
  buildBackendIdMaps: (...args: unknown[]) => buildBackendIdMapsMock(...args),
}));

const getDebugOptionsMock = jest.fn(() => ({
  enabled: false,
  profileDomCapture: false,
}));

jest.mock("@/debug/options", () => ({
  getDebugOptions: () => getDebugOptionsMock(),
}));

describe("getA11yDOM error formatting", () => {
  beforeEach(() => {
    getCDPClientMock.mockReset();
    getOrCreateFrameContextManagerMock.mockReset();
    getDebugOptionsMock.mockReset();
    buildBackendIdMapsMock.mockReset();
    getDebugOptionsMock.mockReturnValue({
      enabled: false,
      profileDomCapture: false,
    });
  });

  it("formats non-Error failures from script injection and returns fallback state", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const page = {
      evaluate: jest.fn().mockRejectedValue({ reason: "inject failed" }),
    } as unknown as Page;

    try {
      const result = await getA11yDOM(page);

      expect(result.domState).toBe("Error: Could not extract accessibility tree");
      expect(result.elements.size).toBe(0);
      expect(result.frameMap?.size ?? 0).toBe(0);
      expect(errorSpy).toHaveBeenCalledWith(
        'Error extracting accessibility tree: {"reason":"inject failed"}'
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("sanitizes and truncates oversized extraction diagnostics", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const page = {
      evaluate: jest
        .fn()
        .mockRejectedValue(new Error(`inject\u0000\n${"x".repeat(10_000)}`)),
    } as unknown as Page;

    try {
      const result = await getA11yDOM(page);

      expect(result.domState).toBe("Error: Could not extract accessibility tree");
      const diagnostic = String(errorSpy.mock.calls[0]?.[0] ?? "");
      expect(diagnostic).toContain("[truncated");
      expect(diagnostic).not.toContain("\u0000");
      expect(diagnostic).not.toContain("\n");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("sanitizes nested error-detail payloads for extraction failures", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const page = {
      evaluate: jest
        .fn()
        .mockRejectedValue(new Error(`detail\u0000\n${"x".repeat(5_000)}`)),
    } as unknown as Page;

    try {
      await getA11yDOM(page);

      const detailsCall = errorSpy.mock.calls.find(
        (call) => String(call[0] ?? "") === "Error details:"
      );
      expect(detailsCall).toBeDefined();
      const details = (detailsCall?.[1] ?? {}) as {
        message?: string;
        stack?: string;
      };
      expect(details.message).toContain("[truncated");
      expect(details.message).not.toContain("\u0000");
      expect(details.message).not.toContain("\n");
      expect(details.stack ?? "").not.toContain("\u0000");
      expect((details.stack ?? "").length).toBeLessThan(700);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("continues when frame manager debug setter throws", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const page = {
      evaluate: jest.fn().mockResolvedValue(undefined),
    } as unknown as Page;
    getCDPClientMock.mockResolvedValue({
      acquireSession: jest
        .fn()
        .mockRejectedValue(new Error("dom session unavailable")),
    });
    getOrCreateFrameContextManagerMock.mockReturnValue({
      setDebug: jest.fn(() => {
        throw new Error(`debug\u0000\n${"x".repeat(5_000)}`);
      }),
      ensureInitialized: jest.fn().mockResolvedValue(undefined),
    });

    try {
      const result = await getA11yDOM(page);
      expect(result.domState).toBe("Error: Could not extract accessibility tree");
      const warning = String(
        warnSpy.mock.calls.find((call) =>
          String(call[0] ?? "").includes("configure frame manager debug")
        )?.[0] ?? ""
      );
      expect(warning).toContain("[truncated");
      expect(warning).not.toContain("\u0000");
      expect(warning).not.toContain("\n");
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("continues when frame manager filtering setter throws", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const page = {
      evaluate: jest.fn().mockResolvedValue(undefined),
    } as unknown as Page;
    getCDPClientMock.mockResolvedValue({
      acquireSession: jest
        .fn()
        .mockRejectedValue(new Error("dom session unavailable")),
    });
    getOrCreateFrameContextManagerMock.mockReturnValue({
      setDebug: jest.fn(),
      setFrameFilteringEnabled: jest.fn(() => {
        throw new Error(`filter\u0000\n${"y".repeat(5_000)}`);
      }),
      ensureInitialized: jest.fn().mockResolvedValue(undefined),
    });

    try {
      const result = await getA11yDOM(page, false, false, undefined, {
        filterAdTrackingFrames: false,
      });
      expect(result.domState).toBe("Error: Could not extract accessibility tree");
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
      errorSpy.mockRestore();
    }
  });

  it("continues when debug options lookup throws", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const page = {
      evaluate: jest.fn().mockResolvedValue(undefined),
    } as unknown as Page;
    getDebugOptionsMock.mockImplementationOnce(() => {
      throw new Error(`debug\u0000\n${"x".repeat(5_000)}`);
    });
    getCDPClientMock.mockResolvedValue({
      acquireSession: jest
        .fn()
        .mockRejectedValue(new Error("dom session unavailable")),
    });
    getOrCreateFrameContextManagerMock.mockReturnValue({
      setDebug: jest.fn(),
      ensureInitialized: jest.fn().mockResolvedValue(undefined),
    });

    try {
      const result = await getA11yDOM(page);
      expect(result.domState).toBe("Error: Could not extract accessibility tree");
      const warning = String(
        warnSpy.mock.calls.find((call) =>
          String(call[0] ?? "").includes("Failed to read debug options")
        )?.[0] ?? ""
      );
      expect(warning).toContain("[truncated");
      expect(warning).not.toContain("\u0000");
      expect(warning).not.toContain("\n");
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("continues when a11y options getters trap", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const page = {
      evaluate: jest.fn().mockResolvedValue(undefined),
    } as unknown as Page;
    getCDPClientMock.mockResolvedValue({
      acquireSession: jest
        .fn()
        .mockRejectedValue(new Error("dom session unavailable")),
    });
    const setFrameFilteringEnabled = jest.fn();
    getOrCreateFrameContextManagerMock.mockReturnValue({
      setDebug: jest.fn(),
      setFrameFilteringEnabled,
      ensureInitialized: jest.fn().mockResolvedValue(undefined),
    });
    const trappedOptions = new Proxy(
      {},
      {
        get: (_target, prop: string | symbol) => {
          if (
            prop === "filterAdTrackingFrames" ||
            prop === "useCache" ||
            prop === "onFrameChunk"
          ) {
            throw new Error("a11y options trap");
          }
          return undefined;
        },
      }
    );

    try {
      const result = await getA11yDOM(
        page,
        false,
        false,
        undefined,
        trappedOptions as unknown as Parameters<typeof getA11yDOM>[4]
      );
      expect(result.domState).toBe("Error: Could not extract accessibility tree");
      expect(setFrameFilteringEnabled).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("continues when runtime listener method getter traps during context collection", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const page = {
      evaluate: jest.fn().mockResolvedValue(undefined),
      url: jest.fn(() => "https://example.com"),
    } as unknown as Page;
    const session = {
      id: "session-1",
      send: jest.fn(async (method: string) => {
        if (method === "Accessibility.getFullAXTree") {
          throw new Error("stop after context collection");
        }
        return {};
      }),
      get on() {
        throw new Error(`listener-on\u0000\n${"x".repeat(2_000)}`);
      },
      off: jest.fn(),
    };
    getCDPClientMock.mockResolvedValue({
      acquireSession: jest.fn().mockResolvedValue(session),
    });
    getOrCreateFrameContextManagerMock.mockReturnValue({
      setDebug: jest.fn(),
      ensureInitialized: jest.fn().mockResolvedValue(undefined),
      captureOOPIFs: jest.fn().mockResolvedValue(undefined),
      setFrameFilteringEnabled: jest.fn(),
    });
    buildBackendIdMapsMock.mockResolvedValue({
      frameMap: new Map([
        [
          1,
          {
            frameIndex: 1,
            siblingPosition: 0,
            src: "https://example.com/frame",
            xpath: "//iframe[1]",
            parentFrameIndex: 0,
            frameId: "frame-1",
          },
        ],
      ]),
      backendNodeMap: {},
      xpathMap: {},
      frameMetadataMap: new Map(),
      frameTree: new Map(),
    });

    try {
      const result = await getA11yDOM(page, true);
      expect(result.domState).toBe("Error: Could not extract accessibility tree");
      const warning = String(
        warnSpy.mock.calls.find((call) =>
          String(call[0] ?? "").includes(
            "Failed to read Runtime.executionContextCreated listener method"
          )
        )?.[0] ?? ""
      );
      expect(warning).toContain("[truncated");
      expect(warning).not.toContain("\u0000");
      expect(warning).not.toContain("\n");
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("continues when runtime sender getter traps during context collection", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const page = {
      evaluate: jest.fn().mockResolvedValue(undefined),
      url: jest.fn(() => "https://example.com"),
    } as unknown as Page;
    let sendGetterReadCount = 0;
    const session = {
      id: "session-1",
      get send() {
        sendGetterReadCount += 1;
        if (sendGetterReadCount === 2) {
          throw new Error(`runtime-send\u0000\n${"x".repeat(2_000)}`);
        }
        return async (method: string) => {
          if (method === "Accessibility.getFullAXTree") {
            throw new Error("stop after context collection");
          }
          return {};
        };
      },
      on: jest.fn(),
      off: jest.fn(),
    };
    getCDPClientMock.mockResolvedValue({
      acquireSession: jest.fn().mockResolvedValue(session),
    });
    getOrCreateFrameContextManagerMock.mockReturnValue({
      setDebug: jest.fn(),
      ensureInitialized: jest.fn().mockResolvedValue(undefined),
      captureOOPIFs: jest.fn().mockResolvedValue(undefined),
      setFrameFilteringEnabled: jest.fn(),
    });
    buildBackendIdMapsMock.mockResolvedValue({
      frameMap: new Map([
        [
          1,
          {
            frameIndex: 1,
            siblingPosition: 0,
            src: "https://example.com/frame",
            xpath: "//iframe[1]",
            parentFrameIndex: 0,
            frameId: "frame-1",
          },
        ],
      ]),
      backendNodeMap: {},
      xpathMap: {},
      frameMetadataMap: new Map(),
      frameTree: new Map(),
    });

    try {
      const result = await getA11yDOM(page, true);
      expect(result.domState).toBe("Error: Could not extract accessibility tree");
      const warning = String(
        warnSpy.mock.calls.find((call) =>
          String(call[0] ?? "").includes("Failed to read Runtime.enable sender")
        )?.[0] ?? ""
      );
      expect(warning).toContain("[truncated");
      expect(warning).not.toContain("\u0000");
      expect(warning).not.toContain("\n");
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("continues when sync frame-manager debug setter traps", async () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const page = {
      evaluate: jest.fn().mockResolvedValue(undefined),
      url: jest.fn(() => "https://example.com"),
    } as unknown as Page;
    const session = {
      id: "session-1",
      send: jest.fn(async (method: string) => {
        if (method === "Accessibility.getFullAXTree") {
          return { nodes: [] };
        }
        if (method === "Page.getFrameTree") {
          throw new Error("frame tree unavailable");
        }
        return {};
      }),
      on: jest.fn(),
      off: jest.fn(),
    };
    getCDPClientMock.mockResolvedValue({
      rootSession: session,
      acquireSession: jest.fn().mockResolvedValue(session),
    });
    getOrCreateFrameContextManagerMock.mockReturnValue({
      setDebug: jest
        .fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementation(() => {
          throw new Error(`sync-debug\u0000\n${"x".repeat(2_000)}`);
        }),
      ensureInitialized: jest.fn().mockResolvedValue(undefined),
      captureOOPIFs: jest.fn().mockResolvedValue(undefined),
      setFrameFilteringEnabled: jest.fn(),
      getOOPIFs: jest.fn(() => []),
      getFrameIndex: jest.fn(),
      getFrameSession: jest.fn(),
      getExecutionContextId: jest.fn(),
      getFrameIdByIndex: jest.fn(),
      getFrameByBackendNodeId: jest.fn(),
      setFrameSession: jest.fn(),
      upsertFrame: jest.fn(),
      assignFrameIndex: jest.fn(),
    });
    buildBackendIdMapsMock.mockResolvedValue({
      frameMap: new Map(),
      backendNodeMap: {},
      xpathMap: {},
      frameMetadataMap: new Map(),
      frameTree: new Map(),
    });

    try {
      const result = await getA11yDOM(page, true);
      expect(result.domState).toBe("Error: Could not extract accessibility tree");
      const warning = String(
        warnSpy.mock.calls.find((call) =>
          String(call[0] ?? "").includes("Failed to configure sync debug mode")
        )?.[0] ?? ""
      );
      expect(warning).toContain("[truncated");
      expect(warning).not.toContain("\u0000");
      expect(warning).not.toContain("\n");
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("continues cache hydration when frame-manager debug setter traps", async () => {
    const page = {
      url: jest.fn(() => "https://example.com"),
    } as unknown as Page;
    const cachedState = {
      domState: "cached dom",
      elements: new Map(),
      xpathMap: {},
      backendNodeMap: {},
      frameMap: new Map([
        [
          1,
          {
            frameIndex: 1,
            siblingPosition: 0,
            frameId: "frame-1",
            xpath: "//iframe[1]",
            parentFrameIndex: 0,
          },
        ],
      ]),
    } as unknown as Parameters<typeof domSnapshotCache.set>[1];
    domSnapshotCache.set(page, cachedState);

    const rootSession = {
      id: "session-1",
      send: jest.fn().mockResolvedValue({
        frameTree: {
          frame: {
            id: "root-frame",
            parentId: undefined,
            loaderId: "loader-1",
            name: "root",
            url: "https://example.com",
          },
        },
      }),
    };
    const ensureInitialized = jest.fn().mockResolvedValue(undefined);
    getCDPClientMock.mockResolvedValue({
      rootSession,
    });
    getOrCreateFrameContextManagerMock.mockReturnValue({
      setDebug: jest.fn(() => {
        throw new Error("cache-hydration debug trap");
      }),
      ensureInitialized,
      upsertFrame: jest.fn(),
      assignFrameIndex: jest.fn(),
      setFrameSession: jest.fn(),
      getFrameByBackendNodeId: jest.fn(),
      getFrameSession: jest.fn(),
    });

    try {
      const result = await getA11yDOM(page, false, false, undefined, {
        useCache: true,
      });
      expect(result.domState).toBe("cached dom");
      expect(ensureInitialized).toHaveBeenCalled();
    } finally {
      domSnapshotCache.invalidate(page);
    }
  });
});
