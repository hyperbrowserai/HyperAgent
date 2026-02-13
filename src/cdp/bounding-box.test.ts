import { getBoundingBox } from "@/cdp/bounding-box";
import type { CDPSession } from "@/cdp/types";

describe("bounding-box error formatting", () => {
  it("formats non-Error failures from domain enabling and quad lookup", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const session: CDPSession = {
      id: "test-session",
      raw: undefined,
      send: async <T = unknown>(method: string): Promise<T> => {
        if (method === "DOM.enable") {
          throw { reason: "dom enable object failure" };
        }
        if (method === "DOM.getContentQuads") {
          throw { reason: "quads object failure" };
        }
        return {} as T;
      },
      on: jest.fn(),
      off: jest.fn(),
      detach: jest.fn(async () => undefined),
    };

    try {
      const result = await getBoundingBox({
        session,
        backendNodeId: 123,
      });

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        '[CDP][BoundingBox] Failed to enable DOM domain: {"reason":"dom enable object failure"}'
      );
      expect(warnSpy).toHaveBeenCalledWith(
        '[CDP][BoundingBox] Failed to get content quads: {"reason":"quads object failure"}'
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("sanitizes and truncates oversized diagnostics", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const noisyFailure = `quads\u0000\n${"x".repeat(10_000)}`;
    const session: CDPSession = {
      id: "test-session",
      raw: undefined,
      send: async <T = unknown>(method: string): Promise<T> => {
        if (method === "DOM.enable") {
          return {} as T;
        }
        if (method === "DOM.getContentQuads") {
          throw new Error(noisyFailure);
        }
        return {} as T;
      },
      on: jest.fn(),
      off: jest.fn(),
      detach: jest.fn(async () => undefined),
    };

    try {
      const result = await getBoundingBox({
        session,
        backendNodeId: 456,
      });

      expect(result).toBeNull();
      const quadsWarning = warnSpy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes("Failed to get content quads"));
      expect(quadsWarning).toBeDefined();
      expect(quadsWarning).toContain("[truncated");
      expect(quadsWarning).not.toContain("\u0000");
      expect(quadsWarning).not.toContain("\n");
      expect(quadsWarning?.length ?? 0).toBeLessThan(700);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
