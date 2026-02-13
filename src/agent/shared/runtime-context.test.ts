import type { Page } from "playwright-core";
import { initializeRuntimeContext } from "@/agent/shared/runtime-context";

const getCDPClientMock = jest.fn();
const getOrCreateFrameContextManagerMock = jest.fn();

jest.mock("@/cdp", () => ({
  getCDPClient: (...args: unknown[]) => getCDPClientMock(...args),
  getOrCreateFrameContextManager: (...args: unknown[]) =>
    getOrCreateFrameContextManagerMock(...args),
}));

describe("initializeRuntimeContext", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("acquires CDP client and initializes frame manager", async () => {
    const page = {} as unknown as Page;
    const cdpClient = { id: "client-1" };
    const frameContextManager = {
      setDebug: jest.fn(),
      ensureInitialized: jest.fn().mockResolvedValue(undefined),
    };
    getCDPClientMock.mockResolvedValue(cdpClient);
    getOrCreateFrameContextManagerMock.mockReturnValue(frameContextManager);

    const result = await initializeRuntimeContext(page, true);

    expect(result).toEqual({
      cdpClient,
      frameContextManager,
    });
    expect(frameContextManager.setDebug).toHaveBeenCalledWith(true);
    expect(frameContextManager.ensureInitialized).toHaveBeenCalledTimes(1);
  });

  it("initializes even when setDebug is unavailable", async () => {
    const page = {} as unknown as Page;
    const cdpClient = { id: "client-2" };
    const frameContextManager = {
      ensureInitialized: jest.fn().mockResolvedValue(undefined),
    };
    getCDPClientMock.mockResolvedValue(cdpClient);
    getOrCreateFrameContextManagerMock.mockReturnValue(frameContextManager);

    const result = await initializeRuntimeContext(page, true);

    expect(result.frameContextManager).toBe(frameContextManager);
    expect(frameContextManager.ensureInitialized).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid page instances", async () => {
    await expect(
      initializeRuntimeContext(undefined as unknown as Page)
    ).rejects.toThrow(
      "[FrameContext] Invalid page instance for runtime initialization"
    );
  });

  it("throws readable errors when CDP client acquisition fails", async () => {
    const page = {} as unknown as Page;
    getCDPClientMock.mockRejectedValue({ reason: "cdp unavailable" });

    await expect(initializeRuntimeContext(page)).rejects.toThrow(
      '[FrameContext] Failed to acquire CDP client: {"reason":"cdp unavailable"}'
    );
  });

  it("truncates oversized CDP acquisition diagnostics", async () => {
    const page = {} as unknown as Page;
    getCDPClientMock.mockRejectedValue(new Error(`x${"y".repeat(2_000)}\ncdp trap`));

    await expect(initializeRuntimeContext(page)).rejects.toThrow(/\[truncated/);
  });

  it("throws when frame context manager is invalid", async () => {
    const page = {} as unknown as Page;
    getCDPClientMock.mockResolvedValue({ id: "client-3" });
    getOrCreateFrameContextManagerMock.mockReturnValue({});

    await expect(initializeRuntimeContext(page)).rejects.toThrow(
      "[FrameContext] Invalid frame context manager: ensureInitialized() is unavailable"
    );
  });

  it("logs and throws readable errors when initialization fails", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const page = {} as unknown as Page;
    getCDPClientMock.mockResolvedValue({ id: "client-4" });
    getOrCreateFrameContextManagerMock.mockReturnValue({
      setDebug: jest.fn(),
      ensureInitialized: jest.fn().mockRejectedValue(new Error("init failed")),
    });

    try {
      await expect(initializeRuntimeContext(page, true)).rejects.toThrow(
        "[FrameContext] Failed to initialize frame context manager: init failed"
      );
      expect(warnSpy).toHaveBeenCalledWith(
        "[FrameContext] Failed to initialize frame context manager:",
        "init failed"
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("truncates oversized initialization diagnostics in logs and errors", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const page = {} as unknown as Page;
    getCDPClientMock.mockResolvedValue({ id: "client-5" });
    getOrCreateFrameContextManagerMock.mockReturnValue({
      setDebug: jest.fn(),
      ensureInitialized: jest
        .fn()
        .mockRejectedValue(new Error(`x${"y".repeat(2_000)}\ninit failed`)),
    });

    try {
      await expect(initializeRuntimeContext(page, true)).rejects.toThrow(
        /\[truncated/
      );
      const warnMessage = String(warnSpy.mock.calls[0]?.[1] ?? "");
      expect(warnMessage).toContain("[truncated");
      expect(warnMessage).not.toContain("\n");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
