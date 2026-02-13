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

describe("dispatchCDPAction argument coercion", () => {
  it("preserves numeric zero values for type and fill actions", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const session = createSession(async (method, params) => {
      calls.push({ method, params });
      return {};
    });
    const ctx = {
      element: {
        session,
        frameId: "frame-1",
        backendNodeId: 11,
        objectId: "obj-1",
      },
    };

    await dispatchCDPAction("type", [0], ctx);
    await dispatchCDPAction("fill", [0], ctx);

    const insertTextCall = calls.find(
      (call) => call.method === "Input.insertText"
    );
    expect(insertTextCall?.params?.text).toBe("0");

    const fillCall = calls.find(
      (call) =>
        call.method === "Runtime.callFunctionOn" &&
        typeof call.params?.functionDeclaration === "string" &&
        (call.params.functionDeclaration as string).includes("function(rawValue)")
    );
    const fillArgs = fillCall?.params?.arguments as
      | Array<{ value?: unknown }>
      | undefined;
    expect(fillArgs?.[0]?.value).toBe("0");
  });

  it("preserves numeric zero values for selectOption action", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const session = createSession(async (method, params) => {
      calls.push({ method, params });
      return { result: { value: { status: "selected", value: "0" } } };
    });

    await dispatchCDPAction("selectOptionFromDropdown", [0], {
      element: {
        session,
        frameId: "frame-1",
        backendNodeId: 11,
        objectId: "obj-1",
      },
    });

    const selectCall = calls.find(
      (call) =>
        call.method === "Runtime.callFunctionOn" &&
        typeof call.params?.functionDeclaration === "string" &&
        (call.params.functionDeclaration as string).includes("function(rawValue)")
    );
    const selectArgs = selectCall?.params?.arguments as
      | Array<{ value?: unknown }>
      | undefined;
    expect(selectArgs?.[0]?.value).toBe("0");
  });

  it("still commits Enter for empty type action with commitEnter", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const session = createSession(async (method, params) => {
      calls.push({ method, params });
      return {};
    });

    await dispatchCDPAction("type", ["", { commitEnter: true }], {
      element: {
        session,
        frameId: "frame-1",
        backendNodeId: 11,
        objectId: "obj-1",
      },
    });

    expect(calls.some((call) => call.method === "Input.insertText")).toBe(false);
    expect(
      calls.some(
        (call) =>
          call.method === "Input.dispatchKeyEvent" &&
          call.params?.type === "keyDown" &&
          call.params?.key === "Enter"
      )
    ).toBe(true);
  });
});
