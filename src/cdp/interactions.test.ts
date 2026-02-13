import { dispatchCDPAction } from "@/cdp/interactions";
import type { CDPSession } from "@/cdp/types";

function createSession(
  sendImpl: (method: string, params?: Record<string, unknown>) => Promise<unknown>
): CDPSession {
  const send: CDPSession["send"] = async <T = unknown>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> => {
    const response = await sendImpl(method, params);
    return response as T;
  };

  return {
    send,
    on: jest.fn(),
    off: jest.fn(),
    detach: jest.fn(async () => undefined),
  };
}

describe("dispatchCDPAction scroll fallback failures", () => {
  it("formats non-Error primary/fallback failures for scrollToElement", async () => {
    const session = createSession(async (method) => {
      if (method === "DOM.scrollIntoViewIfNeeded") {
        throw { primary: "scroll failed" };
      }
      if (method === "Runtime.callFunctionOn") {
        throw { fallback: "runtime fallback failed" };
      }
      return {};
    });

    await expect(
      dispatchCDPAction("scrollToElement", [], {
        element: {
          session,
          frameId: "frame-1",
          backendNodeId: 11,
          objectId: "obj-1",
        },
      })
    ).rejects.toThrow(
      '[CDP][Interactions] Failed to scroll element into view. Primary method failed: {"primary":"scroll failed"}. Fallback also failed: {"fallback":"runtime fallback failed"}'
    );
  });

  it("formats non-Error primary/fallback failures for click scroll pre-step", async () => {
    const session = createSession(async (method) => {
      if (method === "DOM.enable" || method === "Runtime.enable") {
        return {};
      }
      if (method === "DOM.scrollIntoViewIfNeeded") {
        throw { primary: "scroll failed" };
      }
      if (method === "Runtime.callFunctionOn") {
        throw { fallback: "runtime fallback failed" };
      }
      return {};
    });

    await expect(
      dispatchCDPAction("click", [], {
        element: {
          session,
          frameId: "frame-1",
          backendNodeId: 11,
          objectId: "obj-1",
        },
      })
    ).rejects.toThrow(
      '[CDP][Interactions] Failed to scroll element into view. Primary method failed: {"primary":"scroll failed"}. Fallback also failed: {"fallback":"runtime fallback failed"}'
    );
  });
});

describe("dispatchCDPAction press key normalization", () => {
  it("falls back to Enter when press key is blank", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const session = createSession(async (method, params) => {
      calls.push({ method, params });
      return {};
    });

    await dispatchCDPAction("press", ["   "], {
      element: {
        session,
        frameId: "frame-1",
        backendNodeId: 11,
        objectId: "obj-1",
      },
    });

    const keyDown = calls.find(
      (call) =>
        call.method === "Input.dispatchKeyEvent" &&
        call.params?.type === "keyDown"
    );

    expect(keyDown?.params?.key).toBe("Enter");
    expect(keyDown?.params?.code).toBe("Enter");
    expect(keyDown?.params?.windowsVirtualKeyCode).toBe(13);
  });

  it("trims whitespace around named press keys", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const session = createSession(async (method, params) => {
      calls.push({ method, params });
      return {};
    });

    await dispatchCDPAction("press", ["  tab  "], {
      element: {
        session,
        frameId: "frame-1",
        backendNodeId: 11,
        objectId: "obj-1",
      },
    });

    const keyDown = calls.find(
      (call) =>
        call.method === "Input.dispatchKeyEvent" &&
        call.params?.type === "keyDown"
    );

    expect(keyDown?.params?.key).toBe("Tab");
    expect(keyDown?.params?.code).toBe("Tab");
    expect(keyDown?.params?.windowsVirtualKeyCode).toBe(9);
  });
});
