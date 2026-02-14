import type { CDPClient, CDPSession } from "@/cdp/types";
import { resolveElement } from "@/cdp/element-resolver";
import type { EncodedId, IframeInfo } from "@/context-providers/a11y-dom/types";

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

describe("resolveElement diagnostics", () => {
  it("sanitizes and truncates frame identifiers in missing execution-context warnings", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const encodedId = "1-500" as EncodedId;
    const noisyFrameId = `frame\u0000\n${"x".repeat(500)}`;
    const frameInfo = {
      frameId: noisyFrameId,
    } as unknown as IframeInfo;
    const session = createSession(
      async <T = unknown>(method: string): Promise<T> => {
      if (method === "Runtime.evaluate") {
        return { result: { objectId: "runtime-obj" } } as T;
      }
      if (method === "DOM.describeNode") {
        return { node: { backendNodeId: 500 } } as T;
      }
      if (method === "DOM.resolveNode") {
        return { object: { objectId: "resolved-obj" } } as T;
      }
        return {} as T;
      }
    );

    const frameManager = {
      getFrameIdByIndex: () => noisyFrameId,
      getFrameSession: () => session,
      getExecutionContextId: () => undefined,
      waitForExecutionContext: async () => {
        throw new Error("context wait failed");
      },
    };

    try {
      const result = await resolveElement(encodedId, {
        page: {} as never,
        cdpClient: {} as CDPClient,
        backendNodeMap: {},
        xpathMap: {
          [encodedId]: "//button",
        },
        frameMap: new Map([[1, frameInfo]]),
        frameContextManager: frameManager as never,
      });

      expect(result.backendNodeId).toBe(500);
      const warning = String(warnSpy.mock.calls[0]?.[0] ?? "");
      expect(warning).toContain("[truncated");
      expect(warning).not.toContain("\u0000");
      expect(warning).not.toContain("\n");
      expect(warning.length).toBeLessThan(900);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("sanitizes and truncates encoded identifiers in XPath-missing errors", async () => {
    const encodedId = `0-\u0000\n${"y".repeat(500)}` as EncodedId;
    const session = createSession(
      async <T = unknown>(method: string): Promise<T> => {
      if (method === "DOM.resolveNode") {
        return { object: { objectId: "resolved-obj" } } as T;
      }
      return {} as T;
      }
    );
    const frameManager = {
      getFrameIdByIndex: () => "root",
      getFrameSession: () => session,
      getExecutionContextId: () => undefined,
      waitForExecutionContext: async () => undefined,
    };

    await resolveElement(encodedId, {
      page: {} as never,
      cdpClient: {} as CDPClient,
      backendNodeMap: {},
      xpathMap: {},
      frameContextManager: frameManager as never,
    })
      .then(() => {
        throw new Error("expected resolveElement to reject");
      })
      .catch((error) => {
      const message = String(error instanceof Error ? error.message : error);
      expect(message).toContain("XPath not found for encodedId");
      expect(message).toContain("[truncated");
      expect(message).not.toContain("\u0000");
      expect(message).not.toContain("\n");
      expect(message.length).toBeLessThan(500);
      });
  });
});
