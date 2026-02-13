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

  it("normalizes spaced and dashed named keys", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const session = createSession(async (method, params) => {
      calls.push({ method, params });
      return {};
    });

    await dispatchCDPAction("press", ["Arrow Up"], {
      element: {
        session,
        frameId: "frame-1",
        backendNodeId: 11,
        objectId: "obj-1",
      },
    });
    await dispatchCDPAction("press", ["page-down"], {
      element: {
        session,
        frameId: "frame-1",
        backendNodeId: 11,
        objectId: "obj-1",
      },
    });

    const keyDownCalls = calls.filter(
      (call) =>
        call.method === "Input.dispatchKeyEvent" &&
        call.params?.type === "keyDown"
    );
    expect(keyDownCalls[0]?.params?.key).toBe("ArrowUp");
    expect(keyDownCalls[0]?.params?.windowsVirtualKeyCode).toBe(38);
    expect(keyDownCalls[1]?.params?.key).toBe("PageDown");
    expect(keyDownCalls[1]?.params?.windowsVirtualKeyCode).toBe(34);
  });

  it("supports return and spacebar key aliases", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const session = createSession(async (method, params) => {
      calls.push({ method, params });
      return {};
    });

    await dispatchCDPAction("press", ["return"], {
      element: {
        session,
        frameId: "frame-1",
        backendNodeId: 11,
        objectId: "obj-1",
      },
    });
    await dispatchCDPAction("press", ["spacebar"], {
      element: {
        session,
        frameId: "frame-1",
        backendNodeId: 11,
        objectId: "obj-1",
      },
    });

    const keyDownCalls = calls.filter(
      (call) =>
        call.method === "Input.dispatchKeyEvent" &&
        call.params?.type === "keyDown"
    );
    expect(keyDownCalls[0]?.params?.key).toBe("Enter");
    expect(keyDownCalls[0]?.params?.windowsVirtualKeyCode).toBe(13);
    expect(keyDownCalls[1]?.params?.key).toBe(" ");
    expect(keyDownCalls[1]?.params?.code).toBe("Space");
    expect(keyDownCalls[1]?.params?.text).toBe(" ");
    expect(keyDownCalls[1]?.params?.windowsVirtualKeyCode).toBe(32);
  });

  it("supports page-down shorthand aliases", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const session = createSession(async (method, params) => {
      calls.push({ method, params });
      return {};
    });

    await dispatchCDPAction("press", ["pgdn"], {
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
    expect(keyDown?.params?.key).toBe("PageDown");
    expect(keyDown?.params?.code).toBe("PageDown");
    expect(keyDown?.params?.windowsVirtualKeyCode).toBe(34);
  });

  it("bounds oversized custom key strings before dispatch", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const session = createSession(async (method, params) => {
      calls.push({ method, params });
      return {};
    });
    const oversizedKey = "k".repeat(500);

    await dispatchCDPAction("press", [oversizedKey], {
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
    expect(typeof keyDown?.params?.key).toBe("string");
    expect((keyDown?.params?.key as string).length).toBeLessThanOrEqual(64);
  });

  it("falls back safely when key-string coercion throws", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const session = createSession(async (method, params) => {
      calls.push({ method, params });
      return {};
    });
    const badValue = {
      toString(): string {
        throw new Error("coercion failure");
      },
    };

    await dispatchCDPAction("press", [badValue], {
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
    expect(keyDown?.params?.windowsVirtualKeyCode).toBe(13);
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

  it("throws readable error when selectOption value coercion fails", async () => {
    const session = createSession(async () => ({
      result: { value: { status: "selected", value: "x" } },
    }));
    const badValue = {
      toString(): string {
        throw new Error("coercion failure");
      },
    };

    await expect(
      dispatchCDPAction("selectOptionFromDropdown", [badValue], {
        element: {
          session,
          frameId: "frame-1",
          backendNodeId: 11,
          objectId: "obj-1",
        },
      })
    ).rejects.toThrow(
      "[CDP][Interactions] Failed to coerce action argument to string"
    );
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

  it("falls back to default scroll percentage for null/object targets", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const session = createSession(async (method, params) => {
      calls.push({ method, params });
      return {
        result: {
          value: { status: "done", finalTop: 0, maxScroll: 100 },
        },
      };
    });
    const ctx = {
      element: {
        session,
        frameId: "frame-1",
        backendNodeId: 11,
        objectId: "obj-1",
      },
    };

    await dispatchCDPAction("scrollToPercentage", [null], ctx);
    await dispatchCDPAction("scrollToPercentage", [{ target: null }], ctx);

    const scrollCalls = calls.filter(
      (call) =>
        call.method === "Runtime.callFunctionOn" &&
        typeof call.params?.functionDeclaration === "string" &&
        (call.params.functionDeclaration as string).includes(
          "function(percent, behavior)"
        )
    );
    expect(scrollCalls.length).toBe(2);
    for (const scrollCall of scrollCalls) {
      const args = scrollCall.params?.arguments as
        | Array<{ value?: unknown }>
        | undefined;
      expect(args?.[0]?.value).toBe(50);
    }
  });

  it("sanitizes control characters in scroll percentage strings", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const session = createSession(async (method, params) => {
      calls.push({ method, params });
      return {
        result: {
          value: { status: "done", finalTop: 0, maxScroll: 100 },
        },
      };
    });

    await dispatchCDPAction("scrollToPercentage", ["75\u0007%"], {
      element: {
        session,
        frameId: "frame-1",
        backendNodeId: 11,
        objectId: "obj-1",
      },
    });
    await dispatchCDPAction("scrollToPercentage", ["\u0007"], {
      element: {
        session,
        frameId: "frame-1",
        backendNodeId: 11,
        objectId: "obj-1",
      },
    });

    const scrollCalls = calls.filter(
      (call) =>
        call.method === "Runtime.callFunctionOn" &&
        typeof call.params?.functionDeclaration === "string" &&
        (call.params.functionDeclaration as string).includes(
          "function(percent, behavior)"
        )
    );
    const firstArgs = scrollCalls[0]?.params?.arguments as
      | Array<{ value?: unknown }>
      | undefined;
    const secondArgs = scrollCalls[1]?.params?.arguments as
      | Array<{ value?: unknown }>
      | undefined;

    expect(firstArgs?.[0]?.value).toBe(75);
    expect(secondArgs?.[0]?.value).toBe(50);
  });

  it("normalizes scroll behavior and target strings from object options", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const session = createSession(async (method, params) => {
      calls.push({ method, params });
      return {
        result: {
          value: { status: "done", finalTop: 0, maxScroll: 100 },
        },
      };
    });

    await dispatchCDPAction(
      "scrollTo",
      [
        {
          target: "  80%\u0007 ",
          behavior: "  SMOOTH\u0007 ",
        },
      ],
      {
        element: {
          session,
          frameId: "frame-1",
          backendNodeId: 11,
          objectId: "obj-1",
        },
      }
    );

    const scrollCall = calls.find(
      (call) =>
        call.method === "Runtime.callFunctionOn" &&
        typeof call.params?.functionDeclaration === "string" &&
        (call.params.functionDeclaration as string).includes(
          "function(percent, behavior)"
        )
    );
    const args = scrollCall?.params?.arguments as
      | Array<{ value?: unknown }>
      | undefined;
    expect(args?.[0]?.value).toBe(80);
    expect(args?.[1]?.value).toBe("smooth");
  });

  it("falls back to 50% for non-finite numeric scroll targets", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const session = createSession(async (method, params) => {
      calls.push({ method, params });
      return {
        result: {
          value: { status: "done", finalTop: 0, maxScroll: 100 },
        },
      };
    });

    await dispatchCDPAction("scrollToPercentage", [Number.NaN], {
      element: {
        session,
        frameId: "frame-1",
        backendNodeId: 11,
        objectId: "obj-1",
      },
    });
    await dispatchCDPAction("scrollToPercentage", [Number.POSITIVE_INFINITY], {
      element: {
        session,
        frameId: "frame-1",
        backendNodeId: 11,
        objectId: "obj-1",
      },
    });

    const scrollCalls = calls.filter(
      (call) =>
        call.method === "Runtime.callFunctionOn" &&
        typeof call.params?.functionDeclaration === "string" &&
        (call.params.functionDeclaration as string).includes(
          "function(percent, behavior)"
        )
    );
    const firstArgs = scrollCalls[0]?.params?.arguments as
      | Array<{ value?: unknown }>
      | undefined;
    const secondArgs = scrollCalls[1]?.params?.arguments as
      | Array<{ value?: unknown }>
      | undefined;

    expect(firstArgs?.[0]?.value).toBe(50);
    expect(secondArgs?.[0]?.value).toBe(50);
  });

  it("falls back to 50% for oversized scroll target strings", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const session = createSession(async (method, params) => {
      calls.push({ method, params });
      return {
        result: {
          value: { status: "done", finalTop: 0, maxScroll: 100 },
        },
      };
    });
    const oversizedTarget = "9".repeat(200);

    await dispatchCDPAction("scrollToPercentage", [oversizedTarget], {
      element: {
        session,
        frameId: "frame-1",
        backendNodeId: 11,
        objectId: "obj-1",
      },
    });

    const scrollCall = calls.find(
      (call) =>
        call.method === "Runtime.callFunctionOn" &&
        typeof call.params?.functionDeclaration === "string" &&
        (call.params.functionDeclaration as string).includes(
          "function(percent, behavior)"
        )
    );
    const args = scrollCall?.params?.arguments as
      | Array<{ value?: unknown }>
      | undefined;

    expect(args?.[0]?.value).toBe(50);
  });
});
