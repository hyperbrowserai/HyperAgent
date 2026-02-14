import type { Frame, Page } from "playwright-core";
import { resolveFrameByXPath } from "@/context-providers/a11y-dom/utils";
import type { IframeInfo } from "@/context-providers/a11y-dom/types";

function createPage(overrides?: Partial<Page>): Page {
  const mainFrame = {} as Frame;
  return {
    mainFrame: () => mainFrame,
    frames: () => [mainFrame],
    ...overrides,
  } as unknown as Page;
}

describe("resolveFrameByXPath URL matching", () => {
  it("continues URL matching when one frame.url getter throws", async () => {
    const mainFrame = {
      url: () => "https://example.com",
    } as unknown as Frame;
    const trappedFrame = {
      url: () => {
        throw new Error("url trap");
      },
    } as unknown as Frame;
    const matchedFrame = {
      url: () => "https://example.com/frame",
    } as unknown as Frame;
    const page = createPage({
      mainFrame: () => mainFrame,
      frames: () => [mainFrame, trappedFrame, matchedFrame],
    });

    const frameMap = new Map<number, IframeInfo>([
      [
        1,
        {
          frameIndex: 1,
          siblingPosition: 0,
          src: "https://example.com/frame",
          xpath: "//iframe[1]",
          parentFrameIndex: 0,
        },
      ],
    ]);

    const resolved = await resolveFrameByXPath(page, frameMap, 1);
    expect(resolved).toBe(matchedFrame);
  });

  it("sanitizes control characters in target frame src when URL matching", async () => {
    const mainFrame = {
      url: () => "https://example.com",
    } as unknown as Frame;
    const matchedFrame = {
      url: () => "https://example.com/frame",
    } as unknown as Frame;
    const page = createPage({
      mainFrame: () => mainFrame,
      frames: () => [mainFrame, matchedFrame],
    });

    const frameMap = new Map<number, IframeInfo>([
      [
        1,
        {
          frameIndex: 1,
          siblingPosition: 0,
          src: "  https://example.com/frame\u0000\n  ",
          xpath: "//iframe[1]",
          parentFrameIndex: 0,
        },
      ],
    ]);

    const resolved = await resolveFrameByXPath(page, frameMap, 1);
    expect(resolved).toBe(matchedFrame);
  });

  it("falls back to XPath traversal when page.frames() throws", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const targetFrame = {} as Frame;
    const iframeHandle = {
      contentFrame: jest.fn().mockResolvedValue(targetFrame),
    };
    const iframeLocator = {
      elementHandle: jest.fn().mockResolvedValue(iframeHandle),
    };
    const mainFrame = {
      locator: jest.fn(() => iframeLocator),
    } as unknown as Frame;
    const page = createPage({
      mainFrame: () => mainFrame,
      frames: () => {
        throw new Error(`frames\u0000\n${"x".repeat(2_000)}`);
      },
    });

    const frameMap = new Map<number, IframeInfo>([
      [
        1,
        {
          frameIndex: 1,
          siblingPosition: 0,
          src: "https://example.com/frame",
          xpath: "//iframe[1]",
          parentFrameIndex: 0,
        },
      ],
    ]);

    try {
      const resolved = await resolveFrameByXPath(page, frameMap, 1);
      expect(resolved).toBe(targetFrame);

      const warning = String(warnSpy.mock.calls[0]?.[0] ?? "");
      expect(warning).toContain("Failed to enumerate frames for URL matching");
      expect(warning).toContain("[truncated");
      expect(warning).not.toContain("\u0000");
      expect(warning).not.toContain("\n");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("sanitizes traversal diagnostics when locator traversal throws", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const mainFrame = {
      locator: () => {
        throw new Error(`traverse\u0000\n${"x".repeat(2_000)}`);
      },
    } as unknown as Frame;
    const page = createPage({
      mainFrame: () => mainFrame,
      frames: () => [],
    });

    const frameMap = new Map<number, IframeInfo>([
      [
        1,
        {
          frameIndex: 1,
          siblingPosition: 0,
          xpath: "//iframe[1]",
          parentFrameIndex: 0,
        },
      ],
    ]);

    try {
      const resolved = await resolveFrameByXPath(page, frameMap, 1);
      expect(resolved).toBeNull();
      const warning = warnSpy.mock.calls
        .map((call) => String(call[0] ?? ""))
        .find((entry) => entry.includes("Error traversing frame 1"));
      expect(warning).toBeDefined();
      expect(warning).toContain("[truncated");
      expect(warning).not.toContain("\u0000");
      expect(warning).not.toContain("\n");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
