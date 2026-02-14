import { buildBackendIdMaps } from "@/context-providers/a11y-dom/build-maps";
import type { CDPSession } from "@/cdp";

describe("buildBackendIdMaps", () => {
  it("formats non-Error failures when DOM document fetch fails", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const session: CDPSession = {
      id: "session-1",
      raw: undefined,
      send: async <T = unknown>(method: string): Promise<T> => {
        if (method === "DOM.getDocument") {
          throw { reason: "dom document object failure" };
        }
        return {} as T;
      },
      on: jest.fn(),
      off: jest.fn(),
      detach: jest.fn(async () => undefined),
    };

    try {
      const result = await buildBackendIdMaps(session);

      expect(result.tagNameMap).toEqual({});
      expect(result.xpathMap).toEqual({});
      expect(result.accessibleNameMap).toEqual({});
      expect(result.backendNodeMap).toEqual({});
      expect(result.frameMap?.size ?? 0).toBe(0);
      expect(errorSpy).toHaveBeenCalledWith(
        'Error building backend ID maps: {"reason":"dom document object failure"}'
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("sanitizes and truncates oversized DOM document fetch diagnostics", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const session: CDPSession = {
      id: "session-1",
      raw: undefined,
      send: async <T = unknown>(method: string): Promise<T> => {
        if (method === "DOM.getDocument") {
          throw new Error(`dom\u0000\n${"x".repeat(10_000)}`);
        }
        return {} as T;
      },
      on: jest.fn(),
      off: jest.fn(),
      detach: jest.fn(async () => undefined),
    };

    try {
      const result = await buildBackendIdMaps(session);

      expect(result.tagNameMap).toEqual({});
      const diagnostic = String(errorSpy.mock.calls[0]?.[0] ?? "");
      expect(diagnostic).toContain("[truncated");
      expect(diagnostic).not.toContain("\u0000");
      expect(diagnostic).not.toContain("\n");
      expect(diagnostic.length).toBeLessThan(700);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
