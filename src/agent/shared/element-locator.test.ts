import { getElementLocator } from "@/agent/shared/element-locator";

jest.mock("@/context-providers/a11y-dom", () => {
  const actual = jest.requireActual("@/context-providers/a11y-dom");
  return {
    ...actual,
    toEncodedId: jest.fn((value: string) => value),
    resolveFrameByXPath: jest.fn(),
  };
});

const { toEncodedId, resolveFrameByXPath } = jest.requireMock(
  "@/context-providers/a11y-dom"
) as {
  toEncodedId: jest.Mock;
  resolveFrameByXPath: jest.Mock;
};

function createPage(overrides?: Record<string, unknown>) {
  return {
    locator: jest.fn((selector: string) => ({ selector })),
    frames: jest.fn(() => []),
    ...overrides,
  } as unknown as import("playwright-core").Page;
}

describe("getElementLocator", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("resolves main-frame locator and normalizes xpath", async () => {
    const page = createPage();
    toEncodedId.mockReturnValue("0-10");

    const result = await getElementLocator(
      "0-10",
      {
        "0-10": "  //button[1]/text()  ",
      },
      page
    );

    expect((page.locator as jest.Mock)).toHaveBeenCalledWith("xpath=//button[1]");
    expect(result.xpath).toBe("//button[1]");
  });

  it("rejects empty element IDs", async () => {
    const page = createPage();

    await expect(
      getElementLocator(
        "   ",
        {},
        page
      )
    ).rejects.toThrow("Element ID must be a non-empty string");
  });

  it("throws readable error when xpath map access traps throw", async () => {
    const page = createPage();
    toEncodedId.mockReturnValue("0-10");
    const xpathMap = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "0-10") {
            throw new Error("xpath map trap");
          }
          return undefined;
        },
      }
    );

    await expect(
      getElementLocator(
        "0-10",
        xpathMap as unknown as Record<string, string>,
        page
      )
    ).rejects.toThrow("Element lookup failed for 0-10: xpath map trap");
  });

  it("throws readable error when frame-map lookup traps throw", async () => {
    const page = createPage();
    toEncodedId.mockReturnValue("1-10");
    const frameMap = new Proxy(new Map<number, unknown>(), {
      get: (target, prop, receiver) => {
        if (prop === "has") {
          return () => {
            throw new Error("frame has trap");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as Map<number, never>;

    await expect(
      getElementLocator(
        "1-10",
        { "1-10": "//button[1]" },
        page,
        frameMap
      )
    ).rejects.toThrow("Frame metadata lookup failed for frame 1: frame has trap");
  });

  it("throws readable error when iframe resolution throws", async () => {
    const page = createPage();
    toEncodedId.mockReturnValue("1-10");
    resolveFrameByXPath.mockRejectedValue(new Error("frame resolution failed"));
    const frameMap = new Map<number, unknown>([
      [1, { xpath: "//iframe[1]" }],
    ]) as unknown as Map<number, never>;

    await expect(
      getElementLocator(
        "1-10",
        { "1-10": "//button[1]" },
        page,
        frameMap
      )
    ).rejects.toThrow(
      "Could not resolve frame for element 1-10 (frameIndex: 1): frame resolution failed"
    );
  });

  it("continues when iframe waitForLoadState times out", async () => {
    const frame = {
      waitForLoadState: jest.fn().mockRejectedValue(new Error("timeout")),
      locator: jest.fn((selector: string) => ({ selector })),
      url: jest.fn(() => "https://frame.example"),
      name: jest.fn(() => "frame-1"),
    };
    const page = createPage({
      frames: jest.fn(() => [frame]),
    });
    toEncodedId.mockReturnValue("1-10");
    resolveFrameByXPath.mockResolvedValue(frame);
    const frameMap = new Map<number, unknown>([
      [1, { xpath: "//iframe[1]" }],
    ]) as unknown as Map<number, never>;

    const result = await getElementLocator(
      "1-10",
      { "1-10": "//button[1]" },
      page,
      frameMap
    );

    expect(frame.waitForLoadState).toHaveBeenCalledWith("domcontentloaded", {
      timeout: 5000,
    });
    expect(frame.locator).toHaveBeenCalledWith("xpath=//button[1]");
    expect(result.xpath).toBe("//button[1]");
  });
});
