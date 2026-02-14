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
});
