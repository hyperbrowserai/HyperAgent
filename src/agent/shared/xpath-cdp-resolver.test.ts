import type { CDPClient, CDPSession } from "@/cdp/types";
import type { FrameContextManager } from "@/cdp/frame-context-manager";
import { resolveXPathWithCDP } from "@/agent/shared/xpath-cdp-resolver";

function createSession(
  backendNodeId = 101,
  objectId = "obj-1"
): CDPSession {
  const sendImpl: CDPSession["send"] = async <T = unknown>(method: string) => {
    if (method === "Runtime.evaluate") {
      return {
        result: { objectId },
      } as T;
    }
    if (method === "DOM.describeNode") {
      return {
        node: { backendNodeId },
      } as T;
    }
    return {} as T;
  };

  return {
    id: "session-1",
    send: jest.fn(sendImpl) as CDPSession["send"],
    on: jest.fn(),
    off: jest.fn(),
    detach: jest.fn(async () => undefined),
  };
}

function createClient(session: CDPSession): CDPClient {
  return {
    rootSession: session,
    createSession: jest.fn(async () => session),
    acquireSession: jest.fn(async () => session),
    dispose: jest.fn(async () => undefined),
  };
}

describe("resolveXPathWithCDP", () => {
  it("resolves on main frame without frame manager using root fallback", async () => {
    const session = createSession(321, "obj-main");
    const client = createClient(session);

    const resolved = await resolveXPathWithCDP({
      xpath: "//button[1]",
      frameIndex: 0,
      cdpClient: client,
    });

    expect(resolved).toEqual({
      backendNodeId: 321,
      frameId: "root",
      objectId: "obj-main",
    });
  });

  it("throws clear diagnostics when iframe index is requested without manager", async () => {
    const session = createSession();
    const client = createClient(session);

    await expect(
      resolveXPathWithCDP({
        xpath: "//button[1]",
        frameIndex: 2,
        cdpClient: client,
      })
    ).rejects.toThrow("FrameContextManager unavailable");
  });

  it("throws when iframe execution context is missing", async () => {
    const session = createSession();
    const client = createClient(session);
    const manager = {
      getFrameByIndex: jest.fn((frameIndex: number) =>
        frameIndex === 1
          ? { frameId: "frame-1" }
          : frameIndex === 0
            ? { frameId: "root-frame" }
            : undefined
      ),
      waitForExecutionContext: jest.fn(async () => undefined),
      getFrameIndex: jest.fn((frameId: string) =>
        frameId === "root-frame" ? 0 : frameId === "frame-1" ? 1 : undefined
      ),
      frameGraph: {
        getAllFrames: jest.fn(() => [
          {
            frameId: "root-frame",
            parentFrameId: null,
            lastUpdated: Date.now(),
          },
          {
            frameId: "frame-1",
            parentFrameId: "root-frame",
            lastUpdated: Date.now(),
          },
        ]),
      },
    } as unknown as FrameContextManager;

    await expect(
      resolveXPathWithCDP({
        xpath: "//button[1]",
        frameIndex: 1,
        cdpClient: client,
        frameContextManager: manager,
      })
    ).rejects.toThrow("Execution context missing for frameIndex 1");
  });
});
