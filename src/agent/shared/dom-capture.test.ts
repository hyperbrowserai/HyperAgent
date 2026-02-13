import type { Page } from "playwright-core";
import { captureDOMState } from "@/agent/shared/dom-capture";

jest.mock("@/context-providers/a11y-dom", () => ({
  getA11yDOM: jest.fn(),
}));

jest.mock("@/utils/waitForSettledDOM", () => ({
  waitForSettledDOM: jest.fn(),
}));

const { getA11yDOM } = jest.requireMock(
  "@/context-providers/a11y-dom"
) as {
  getA11yDOM: jest.Mock;
};

const { waitForSettledDOM } = jest.requireMock(
  "@/utils/waitForSettledDOM"
) as {
  waitForSettledDOM: jest.Mock;
};

function createPage(): Page {
  return {} as Page;
}

function createDomState(overrides?: Partial<Record<string, unknown>>) {
  return {
    elements: new Map([["0-1", { name: "button" }]]),
    domState: "dom tree",
    xpathMap: { "0-1": "//button[1]" },
    backendNodeMap: { "0-1": 111 },
    ...overrides,
  };
}

describe("captureDOMState", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    waitForSettledDOM.mockResolvedValue(undefined);
  });

  it("retries recoverable DOM errors and succeeds", async () => {
    getA11yDOM
      .mockRejectedValueOnce(new Error("Execution context was destroyed"))
      .mockResolvedValueOnce(createDomState());

    const result = await captureDOMState(createPage(), { maxRetries: 2 });

    expect(result.domState).toBe("dom tree");
    expect(getA11yDOM).toHaveBeenCalledTimes(2);
    expect(waitForSettledDOM).toHaveBeenCalledTimes(1);
  });

  it("throws immediately for non-recoverable errors", async () => {
    getA11yDOM.mockRejectedValue(new Error("fatal capture failure"));

    await expect(captureDOMState(createPage(), { maxRetries: 3 })).rejects.toThrow(
      "fatal capture failure"
    );
    expect(getA11yDOM).toHaveBeenCalledTimes(1);
    expect(waitForSettledDOM).toHaveBeenCalledTimes(0);
  });

  it("normalizes invalid maxRetries values to default attempts", async () => {
    getA11yDOM.mockResolvedValue(
      createDomState({
        elements: new Map(),
        domState: "Error: Could not extract accessibility tree",
      })
    );

    await expect(captureDOMState(createPage(), { maxRetries: 0 })).rejects.toThrow(
      "Error: Could not extract accessibility tree"
    );
    expect(getA11yDOM).toHaveBeenCalledTimes(3);
  });

  it("ignores onFrameChunk callback errors while streaming", async () => {
    getA11yDOM.mockImplementation(
      async (
        _page: Page,
        _debug: boolean,
        _enableVisualMode: boolean,
        _debugStepDir: string | undefined,
        options?: { onFrameChunk?: (chunk: { order: number; simplified: string }) => void }
      ) => {
        options?.onFrameChunk?.({ order: 0, simplified: " streamed chunk " });
        return createDomState({
          elements: new Map([["0-1", { name: "button" }]]),
          domState: "fallback",
        });
      }
    );

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await captureDOMState(createPage(), {
        enableStreaming: true,
        onFrameChunk: () => {
          throw new Error("stream callback trap");
        },
        debug: true,
      });

      expect(result.domState).toBe("streamed chunk");
      expect(getA11yDOM).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        "[DOM] onFrameChunk callback failed: stream callback trap"
      );
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
