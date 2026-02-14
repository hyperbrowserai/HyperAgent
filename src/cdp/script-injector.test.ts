import type { CDPSession } from "@/cdp/types";
import { ensureScriptInjected } from "@/cdp/script-injector";

function createSession(
  sendImplementation: <T = unknown>(
    method: string,
    params?: Record<string, unknown>
  ) => Promise<T>
): CDPSession {
  return {
    id: "session-1",
    raw: undefined,
    send: sendImplementation,
    on: jest.fn(),
    off: jest.fn(),
    detach: jest.fn(async () => undefined),
  };
}

describe("ensureScriptInjected diagnostics", () => {
  it("sanitizes and truncates oversized registration diagnostics", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const session = createSession(
      async <T = unknown>(method: string): Promise<T> => {
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        throw new Error(`register\u0000\n${"x".repeat(10_000)}`);
      }
      return {} as T;
      }
    );

    try {
      await ensureScriptInjected(
        session,
        `script\u0000\n${"k".repeat(500)}`,
        "window.__script = true;"
      );
      const diagnostic = String(warnSpy.mock.calls[0]?.[0] ?? "");
      expect(diagnostic).toContain("[truncated");
      expect(diagnostic).not.toContain("\u0000");
      expect(diagnostic).not.toContain("\n");
      expect(diagnostic.length).toBeLessThan(900);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("formats non-Error evaluation failures deterministically", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const session = createSession(
      async <T = unknown>(method: string): Promise<T> => {
      if (method === "Runtime.evaluate") {
        throw { reason: "evaluate object failure" };
      }
      return {} as T;
      }
    );

    try {
      await ensureScriptInjected(
        session,
        "script-key",
        "window.__script = true;",
        42
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('{"reason":"evaluate object failure"}')
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
