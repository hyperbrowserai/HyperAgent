import type { CDPSession } from "@/cdp";
import { ensureScriptInjected } from "@/cdp/script-injector";
import {
  batchCollectBoundingBoxesWithFailures,
  type BoundingBoxTarget,
} from "@/context-providers/a11y-dom/bounding-box-batch";
import type { EncodedId } from "@/context-providers/a11y-dom/types";

jest.mock("@/cdp/script-injector", () => ({
  ensureScriptInjected: jest.fn(),
}));

const mockedEnsureScriptInjected = ensureScriptInjected as jest.MockedFunction<
  typeof ensureScriptInjected
>;

function createSession(
  sendImplementation?: <T = unknown>(
    method: string,
    params?: Record<string, unknown>
  ) => Promise<T>
): CDPSession {
  return {
    id: "session-1",
    raw: undefined,
    send:
      sendImplementation ??
      (async <T = unknown>(_method: string): Promise<T> => ({}) as T),
    on: jest.fn(),
    off: jest.fn(),
    detach: jest.fn(async () => undefined),
  };
}

function createTarget(session: CDPSession, frameId: string): BoundingBoxTarget {
  return {
    kind: "cdp",
    session,
    frameId,
  };
}

describe("batchCollectBoundingBoxesWithFailures diagnostics", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedEnsureScriptInjected.mockResolvedValue(undefined);
  });

  it("formats non-Error Runtime.callFunctionOn failures deterministically", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const encodedId = "0-101" as EncodedId;
    const session = createSession(
      async <T = unknown>(method: string): Promise<T> => {
      if (method === "Runtime.callFunctionOn") {
        throw { reason: "batch bbox object failure" };
      }
      return {} as T;
      }
    );

    try {
      const result = await batchCollectBoundingBoxesWithFailures(
        createTarget(session, "frame-main"),
        { [encodedId]: "//button" },
        [{ backendDOMNodeId: 101, encodedId }],
        0
      );

      expect(result.boundingBoxMap.size).toBe(0);
      expect(result.failures).toEqual([{ encodedId, backendNodeId: 101 }]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('{"reason":"batch bbox object failure"}')
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("sanitizes and truncates oversized batch-collection diagnostics", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const encodedId = "3-202" as EncodedId;
    mockedEnsureScriptInjected.mockRejectedValueOnce(
      new Error(`inject\u0000\n${"x".repeat(10_000)}`)
    );
    const session = createSession();
    const noisyFrameId = `frame\u0000\n${"y".repeat(500)}`;

    try {
      const result = await batchCollectBoundingBoxesWithFailures(
        createTarget(session, noisyFrameId),
        { [encodedId]: "//input" },
        [{ backendDOMNodeId: 202, encodedId }],
        3
      );

      expect(result.boundingBoxMap.size).toBe(0);
      expect(result.failures).toEqual([{ encodedId, backendNodeId: 202 }]);
      const diagnostic = String(warnSpy.mock.calls[0]?.[0] ?? "");
      expect(diagnostic).toContain("[truncated");
      expect(diagnostic).not.toContain("\u0000");
      expect(diagnostic).not.toContain("\n");
      expect(diagnostic.length).toBeLessThan(900);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
