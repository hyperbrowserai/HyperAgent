import type { CDPSession as PlaywrightSession, Page } from "playwright-core";
import {
  disposeAllCDPClients,
  disposeCDPClientForPage,
  getCDPClientForPage,
} from "@/cdp/playwright-adapter";

jest.mock("@/debug/options", () => ({
  getDebugOptions: jest.fn(() => ({
    enabled: false,
    cdpSessions: false,
  })),
}));

const { getDebugOptions } = jest.requireMock("@/debug/options") as {
  getDebugOptions: jest.Mock;
};

describe("playwright adapter error formatting", () => {
  afterEach(async () => {
    await disposeAllCDPClients();
    jest.restoreAllMocks();
  });

  it("formats non-Error session detach failures", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const session = {
      send: jest.fn().mockResolvedValue({}),
      on: jest.fn(),
      off: jest.fn(),
      detach: jest.fn().mockRejectedValue({ reason: "detach object failure" }),
    } as unknown as PlaywrightSession;
    const page = {
      context: () => ({
        newCDPSession: jest.fn().mockResolvedValue(session),
      }),
      once: jest.fn(),
    } as unknown as Page;

    await getCDPClientForPage(page);
    await disposeCDPClientForPage(page);

    expect(warnSpy).toHaveBeenCalledWith(
      '[CDP][PlaywrightAdapter] Failed to detach session: {"reason":"detach object failure"}'
    );
  });

  it("sanitizes and truncates oversized detach diagnostics", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const noisyFailure = `detach\u0000\n${"x".repeat(10_000)}`;
    const session = {
      send: jest.fn().mockResolvedValue({}),
      on: jest.fn(),
      off: jest.fn(),
      detach: jest.fn().mockRejectedValue(new Error(noisyFailure)),
    } as unknown as PlaywrightSession;
    const page = {
      context: () => ({
        newCDPSession: jest.fn().mockResolvedValue(session),
      }),
      once: jest.fn(),
    } as unknown as Page;

    await getCDPClientForPage(page);
    await disposeCDPClientForPage(page);

    const detachWarning = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes("Failed to detach session"));
    expect(detachWarning).toBeDefined();
    expect(detachWarning).toContain("[truncated");
    expect(detachWarning).not.toContain("\u0000");
    expect(detachWarning).not.toContain("\n");
    expect(detachWarning?.length ?? 0).toBeLessThan(700);
  });

  it("continues disposing sessions when debug-options lookup traps", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const session = {
      send: jest.fn().mockResolvedValue({}),
      on: jest.fn(),
      off: jest.fn(),
      detach: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlaywrightSession;
    const page = {
      context: () => ({
        newCDPSession: jest.fn().mockResolvedValue(session),
      }),
      once: jest.fn(),
    } as unknown as Page;
    getDebugOptions.mockImplementationOnce(() => {
      throw new Error(`debug\u0000\n${"x".repeat(2_000)}`);
    });

    try {
      const client = await getCDPClientForPage(page);
      await client.acquireSession("lifecycle");
      await disposeCDPClientForPage(page);

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
    }
  });

  it("surfaces sanitized diagnostics when page context traps during init", async () => {
    const page = {
      context: () => {
        throw new Error(`context\u0000\n${"x".repeat(2_000)}`);
      },
      once: jest.fn(),
    } as unknown as Page;

    await expect(getCDPClientForPage(page)).rejects.toThrow(
      "[CDP][PlaywrightAdapter] Failed to create CDP session"
    );

    await expect(getCDPClientForPage(page)).rejects.toThrow("[truncated");
  });

  it("clears pending init promise after context-init failure", async () => {
    const session = {
      send: jest.fn().mockResolvedValue({}),
      on: jest.fn(),
      off: jest.fn(),
      detach: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlaywrightSession;

    const context = jest
      .fn<unknown, []>()
      .mockImplementationOnce(() => {
        throw new Error("first init failure");
      })
      .mockImplementation(() => ({
        newCDPSession: jest.fn().mockResolvedValue(session),
      }));

    const page = {
      context,
      once: jest.fn(),
    } as unknown as Page;

    await expect(getCDPClientForPage(page)).rejects.toThrow(
      "first init failure"
    );
    await expect(getCDPClientForPage(page)).resolves.toBeDefined();
    expect(context).toHaveBeenCalledTimes(2);
  });

  it("warns and continues when close-listener attachment traps", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const session = {
      send: jest.fn().mockResolvedValue({}),
      on: jest.fn(),
      off: jest.fn(),
      detach: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlaywrightSession;

    const page = {
      context: () => ({
        newCDPSession: jest.fn().mockResolvedValue(session),
      }),
      get once() {
        throw new Error(`close-listener\u0000\n${"x".repeat(2_000)}`);
      },
    } as unknown as Page;

    try {
      await expect(getCDPClientForPage(page)).resolves.toBeDefined();
      const warning = String(
        warnSpy.mock.calls.find((call) =>
          String(call[0] ?? "").includes("Failed to attach page close listener")
        )?.[0] ?? ""
      );
      expect(warning).toContain("[truncated");
      expect(warning).not.toContain("\u0000");
      expect(warning).not.toContain("\n");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("creates CDP sessions with the browser-context receiver", async () => {
    const session = {
      send: jest.fn().mockResolvedValue({}),
      on: jest.fn(),
      off: jest.fn(),
      detach: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlaywrightSession;
    const context = {
      newCDPSession: jest.fn(function (this: unknown, target: unknown) {
        if (this !== context) {
          throw new Error("invalid context receiver");
        }
        void target;
        return Promise.resolve(session);
      }),
    };
    const page = {
      context: () => context,
      once: jest.fn(),
    } as unknown as Page;

    const client = await getCDPClientForPage(page);
    await expect(client.acquireSession("lifecycle")).resolves.toBeDefined();
    expect(context.newCDPSession).toHaveBeenCalled();
  });
});
