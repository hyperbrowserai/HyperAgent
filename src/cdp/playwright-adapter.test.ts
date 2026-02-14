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

  it("surfaces sanitized diagnostics when session.detach getter traps", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const session = {
      send: jest.fn().mockResolvedValue({}),
      on: jest.fn(),
      off: jest.fn(),
      get detach() {
        throw new Error(`detach getter trap\u0000\n${"x".repeat(10_000)}`);
      },
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
    expect(detachWarning).toContain("Failed to read session.detach");
    expect(detachWarning).toContain("[truncated");
    expect(detachWarning).not.toContain("\u0000");
    expect(detachWarning).not.toContain("\n");
  });

  it("surfaces explicit diagnostics when session.detach is unavailable", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const session = {
      send: jest.fn().mockResolvedValue({}),
      on: jest.fn(),
      off: jest.fn(),
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
      "[CDP][PlaywrightAdapter] Failed to detach session: [CDP][PlaywrightAdapter] session.detach is unavailable"
    );
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

  it("continues pooled session creation when detach-listener attach traps", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const session = {
      send: jest.fn().mockResolvedValue({}),
      get on() {
        throw new Error(`listener-on\u0000\n${"x".repeat(2_000)}`);
      },
      off: jest.fn(),
      detach: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlaywrightSession;
    const page = {
      context: () => ({
        newCDPSession: jest.fn().mockResolvedValue(session),
      }),
      once: jest.fn(),
    } as unknown as Page;

    try {
      const client = await getCDPClientForPage(page);
      await expect(client.acquireSession("lifecycle")).resolves.toBeDefined();

      const warning = String(
        warnSpy.mock.calls.find((call) =>
          String(call[0] ?? "").includes("Failed to attach pooled lifecycle")
        )?.[0] ?? ""
      );
      expect(warning).toContain("[truncated");
      expect(warning).not.toContain("\u0000");
      expect(warning).not.toContain("\n");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("continues disposal when pooled listener cleanup traps", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const session = {
      send: jest.fn().mockResolvedValue({}),
      on: jest.fn(),
      get off() {
        throw new Error(`listener-off\u0000\n${"x".repeat(2_000)}`);
      },
      detach: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlaywrightSession;
    const page = {
      context: () => ({
        newCDPSession: jest.fn().mockResolvedValue(session),
      }),
      once: jest.fn(),
    } as unknown as Page;

    try {
      const client = await getCDPClientForPage(page);
      await expect(client.acquireSession("lifecycle")).resolves.toBeDefined();
      await expect(disposeCDPClientForPage(page)).resolves.toBeUndefined();

      const warning = String(
        warnSpy.mock.calls.find((call) =>
          String(call[0] ?? "").includes("Failed to detach pooled lifecycle listener")
        )?.[0] ?? ""
      );
      expect(warning).toContain("[truncated");
      expect(warning).not.toContain("\u0000");
      expect(warning).not.toContain("\n");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("surfaces sanitized diagnostics when session.send getter traps", async () => {
    const trappedSession = new Proxy(
      {
        on: jest.fn(),
        off: jest.fn(),
        detach: jest.fn().mockResolvedValue(undefined),
      },
      {
        get: (target, prop, receiver) => {
          if (prop === "send") {
            throw new Error(`send\u0000\n${"x".repeat(2_000)}`);
          }
          return Reflect.get(target, prop, receiver);
        },
      }
    ) as unknown as PlaywrightSession;
    const page = {
      context: () => ({
        newCDPSession: jest.fn().mockResolvedValue(trappedSession),
      }),
      once: jest.fn(),
    } as unknown as Page;

    const client = await getCDPClientForPage(page);
    const pooled = await client.acquireSession("lifecycle");

    await expect(pooled.send("Runtime.enable")).rejects.toThrow(
      "[CDP][PlaywrightAdapter] Failed to read session.send"
    );
    await expect(pooled.send("Runtime.enable")).rejects.toThrow("[truncated");
  });

  it("surfaces sanitized diagnostics when session.on getter traps", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const trappedSession = new Proxy(
      {
        send: jest.fn().mockResolvedValue({}),
        off: jest.fn(),
        detach: jest.fn().mockResolvedValue(undefined),
      },
      {
        get: (target, prop, receiver) => {
          if (prop === "on") {
            throw new Error(`on\u0000\n${"x".repeat(2_000)}`);
          }
          return Reflect.get(target, prop, receiver);
        },
      }
    ) as unknown as PlaywrightSession;
    const page = {
      context: () => ({
        newCDPSession: jest.fn().mockResolvedValue(trappedSession),
      }),
      once: jest.fn(),
    } as unknown as Page;

    const client = await getCDPClientForPage(page);
    const pooled = await client.acquireSession("lifecycle");
    const pooledWithOn = pooled as typeof pooled & {
      on: NonNullable<typeof pooled.on>;
    };

    try {
      expect(() => pooledWithOn.on("Detached", () => undefined)).toThrow(
        "[CDP][PlaywrightAdapter] Failed to read session.on"
      );
      expect(() => pooledWithOn.on("Detached", () => undefined)).toThrow(
        "[truncated"
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("surfaces sanitized diagnostics when session.off getter traps", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const trappedSession = new Proxy(
      {
        send: jest.fn().mockResolvedValue({}),
        on: jest.fn(),
        detach: jest.fn().mockResolvedValue(undefined),
      },
      {
        get: (target, prop, receiver) => {
          if (prop === "off") {
            throw new Error(`off\u0000\n${"x".repeat(2_000)}`);
          }
          return Reflect.get(target, prop, receiver);
        },
      }
    ) as unknown as PlaywrightSession;
    const page = {
      context: () => ({
        newCDPSession: jest.fn().mockResolvedValue(trappedSession),
      }),
      once: jest.fn(),
    } as unknown as Page;

    const client = await getCDPClientForPage(page);
    const pooled = await client.acquireSession("lifecycle");
    const pooledWithOff = pooled as typeof pooled & {
      off: NonNullable<typeof pooled.off>;
    };

    try {
      expect(() => pooledWithOff.off("Detached", () => undefined)).toThrow(
        "[CDP][PlaywrightAdapter] Failed to read session.off"
      );
      expect(() => pooledWithOff.off("Detached", () => undefined)).toThrow(
        "[truncated"
      );
      await disposeCDPClientForPage(page);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("surfaces sanitized diagnostics when session.on listener registration throws", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const trappedSession = {
      send: jest.fn().mockResolvedValue({}),
      on: () => {
        throw new Error(`on-call\u0000\n${"x".repeat(2_000)}`);
      },
      off: jest.fn(),
      detach: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlaywrightSession;
    const page = {
      context: () => ({
        newCDPSession: jest.fn().mockResolvedValue(trappedSession),
      }),
      once: jest.fn(),
    } as unknown as Page;

    const client = await getCDPClientForPage(page);
    const pooled = await client.acquireSession("lifecycle");
    const pooledWithOn = pooled as typeof pooled & {
      on: NonNullable<typeof pooled.on>;
    };

    try {
      expect(() => pooledWithOn.on("Detached", () => undefined)).toThrow(
        "[CDP][PlaywrightAdapter] Failed to register listener (Detached)"
      );
      expect(() => pooledWithOn.on("Detached", () => undefined)).toThrow(
        "[truncated"
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("surfaces sanitized diagnostics when session.off listener removal throws", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const trappedSession = {
      send: jest.fn().mockResolvedValue({}),
      on: jest.fn(),
      off: () => {
        throw new Error(`off-call\u0000\n${"x".repeat(2_000)}`);
      },
      detach: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlaywrightSession;
    const page = {
      context: () => ({
        newCDPSession: jest.fn().mockResolvedValue(trappedSession),
      }),
      once: jest.fn(),
    } as unknown as Page;

    const client = await getCDPClientForPage(page);
    const pooled = await client.acquireSession("lifecycle");
    const pooledWithOff = pooled as typeof pooled & {
      off: NonNullable<typeof pooled.off>;
    };

    try {
      expect(() => pooledWithOff.off("Detached", () => undefined)).toThrow(
        "[CDP][PlaywrightAdapter] Failed to remove listener (Detached)"
      );
      expect(() => pooledWithOff.off("Detached", () => undefined)).toThrow(
        "[truncated"
      );
      await disposeCDPClientForPage(page);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
