import type { Page } from "playwright-core";
import { getA11yDOM } from "@/context-providers/a11y-dom";

const getCDPClientMock = jest.fn();
const getOrCreateFrameContextManagerMock = jest.fn();

jest.mock("@/cdp", () => ({
  getCDPClient: (...args: unknown[]) => getCDPClientMock(...args),
  getOrCreateFrameContextManager: (...args: unknown[]) =>
    getOrCreateFrameContextManagerMock(...args),
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
});
