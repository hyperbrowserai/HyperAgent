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

  it("reuses first lookup value in debug path when map getter becomes trap-prone", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const page = createPage();
    toEncodedId.mockReturnValue("0-10");
    let readCount = 0;
    const xpathMap = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop !== "0-10") {
            return undefined;
          }
          readCount += 1;
          if (readCount > 1) {
            throw new Error("second lookup trap");
          }
          return undefined;
        },
      }
    );

    try {
      await expect(
        getElementLocator(
          "0-10",
          xpathMap as unknown as Record<string, string>,
          page,
          undefined,
          true
        )
      ).rejects.toThrow("Element 0-10 not found in xpath map");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("truncates oversized xpath-map trap diagnostics", async () => {
    const page = createPage();
    toEncodedId.mockReturnValue("0-10");
    const xpathMap = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "0-10") {
            throw new Error(`x${"y".repeat(2_000)}\nxpath trap`);
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
    ).rejects.toThrow(/\[truncated/);
  });

  it("sanitizes oversized element identifiers in lookup failures", async () => {
    const page = createPage();
    const oversizedElementId = `id-${"x".repeat(300)}\nunsafe`;
    toEncodedId.mockReturnValue("0-10");

    await expect(
      getElementLocator(oversizedElementId, {}, page)
    ).rejects.toThrow(/\[truncated/);
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

  it("keeps debug logging resilient when frame metadata access traps throw", async () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const frame = {
      waitForLoadState: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn((selector: string) => ({ selector })),
      url: jest.fn(() => {
        throw new Error("frame url trap");
      }),
      name: jest.fn(() => {
        throw new Error("frame name trap");
      }),
    };
    const page = createPage({
      frames: jest.fn(() => [frame]),
    });
    toEncodedId.mockReturnValue("1-10");
    resolveFrameByXPath.mockResolvedValue(frame);
    const frameMap = new Map<number, unknown>([
      [1, { xpath: "//iframe[1]" }],
    ]) as unknown as Map<number, never>;

    try {
      const result = await getElementLocator(
        "1-10",
        { "1-10": "//button[1]" },
        page,
        frameMap,
        true
      );
      expect(result.xpath).toBe("//button[1]");
      expect(frame.locator).toHaveBeenCalledWith("xpath=//button[1]");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("sanitizes and truncates unresolved-frame debug payload logs", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const page = createPage({
      frames: jest.fn(() => [
        {
          url: () => `https://example.com/\u0000\n${"x".repeat(2_000)}`,
          name: () => `frame\u0000\n${"y".repeat(2_000)}`,
        },
      ]),
    });
    toEncodedId.mockReturnValue("1-10");
    resolveFrameByXPath.mockResolvedValue(null);
    const frameMap = new Map<number, unknown>([
      [
        1,
        {
          src: `https://frame.example/\u0000\n${"x".repeat(2_000)}`,
          name: `name\u0000\n${"y".repeat(2_000)}`,
          xpath: "//iframe[1]",
          parentFrameIndex: 0,
        },
      ],
    ]) as unknown as Map<number, never>;

    try {
      await expect(
        getElementLocator(
          "1-10",
          { "1-10": "//button[1]" },
          page,
          frameMap,
          true
        )
      ).rejects.toThrow("Could not resolve frame for element 1-10");

      const payloadLogs = errorSpy.mock.calls
        .map((call) => String(call[0] ?? ""))
        .filter((entry) =>
          entry.includes("Frame info:") || entry.includes("Available frames:")
        );
      expect(payloadLogs.length).toBeGreaterThanOrEqual(2);
      for (const logLine of payloadLogs) {
        expect(logLine).toContain("[truncated");
        expect(logLine).not.toContain("\u0000");
        expect(logLine).not.toContain("\n");
      }
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("keeps readable frame metadata when one frame entry getter traps", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const frames = new Proxy(
      [
        {},
        {
          url: () => "https://example.com/good-frame",
          name: () => "good-frame",
        },
      ],
      {
        get: (target, prop, receiver) => {
          if (prop === "0") {
            throw new Error("frame entry trap");
          }
          return Reflect.get(target, prop, receiver);
        },
      }
    );
    const page = createPage({
      frames: jest.fn(() => frames),
    });
    toEncodedId.mockReturnValue("1-10");
    resolveFrameByXPath.mockResolvedValue(null);
    const frameMap = new Map<number, unknown>([
      [
        1,
        {
          src: "https://frame.example",
          name: "frame-name",
          xpath: "//iframe[1]",
          parentFrameIndex: 0,
        },
      ],
    ]) as unknown as Map<number, never>;

    try {
      await expect(
        getElementLocator("1-10", { "1-10": "//button[1]" }, page, frameMap, true)
      ).rejects.toThrow("Could not resolve frame for element 1-10");

      const availableFramesLine = String(
        errorSpy.mock.calls.find((call) =>
          String(call[0] ?? "").includes("Available frames:")
        )?.[0] ?? ""
      );
      expect(availableFramesLine).toContain("https://example.com/good-frame");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("reads frame metadata with frame receiver binding", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const frameWithReceiverState = {
      frameUrl: "https://example.com/receiver-frame",
      frameName: "receiver-frame",
      url(this: { frameUrl: string }) {
        return this.frameUrl;
      },
      name(this: { frameName: string }) {
        return this.frameName;
      },
    };
    const page = createPage({
      frames: jest.fn(() => [frameWithReceiverState]),
    });
    toEncodedId.mockReturnValue("1-10");
    resolveFrameByXPath.mockResolvedValue(null);
    const frameMap = new Map<number, unknown>([
      [
        1,
        {
          src: "https://frame.example",
          name: "frame-name",
          xpath: "//iframe[1]",
          parentFrameIndex: 0,
        },
      ],
    ]) as unknown as Map<number, never>;

    try {
      await expect(
        getElementLocator("1-10", { "1-10": "//button[1]" }, page, frameMap, true)
      ).rejects.toThrow("Could not resolve frame for element 1-10");

      const availableFramesLine = String(
        errorSpy.mock.calls.find((call) =>
          String(call[0] ?? "").includes("Available frames:")
        )?.[0] ?? ""
      );
      expect(availableFramesLine).toContain("https://example.com/receiver-frame");
      expect(availableFramesLine).toContain("receiver-frame");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
