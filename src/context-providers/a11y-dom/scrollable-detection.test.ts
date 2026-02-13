import {
  decorateRoleIfScrollable,
  findScrollableElementIds,
  getScrollableElementXpaths,
} from "@/context-providers/a11y-dom/scrollable-detection";
import type { CDPSession } from "@/cdp";

describe("scrollable detection error formatting", () => {
  it("formats non-Error failures when reading scrollable xpaths", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const pageOrFrame = {
      evaluate: jest.fn().mockRejectedValue({ reason: "eval failed" }),
    };

    try {
      const xpaths = await getScrollableElementXpaths(
        pageOrFrame as unknown as Parameters<typeof getScrollableElementXpaths>[0]
      );
      expect(xpaths).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        'Error getting scrollable element xpaths: {"reason":"eval failed"}'
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("formats non-Error failures when resolving xpath backend IDs", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const pageOrFrame = {
      evaluate: jest.fn().mockResolvedValue(["/html/body/div[1]"]),
    };
    const client: CDPSession = {
      id: "cdp-session",
      raw: undefined,
      send: async <T = unknown>(method: string): Promise<T> => {
        if (method === "Runtime.evaluate") {
          throw { reason: "runtime evaluate failed" };
        }
        return {} as T;
      },
      on: jest.fn(),
      off: jest.fn(),
      detach: jest.fn(async () => undefined),
    };

    try {
      const ids = await findScrollableElementIds(
        pageOrFrame as unknown as Parameters<typeof findScrollableElementIds>[0],
        client
      );
      expect(ids.size).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(
        'Error resolving XPath /html/body/div[1]: {"reason":"runtime evaluate failed"}'
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("decorateRoleIfScrollable", () => {
  it("decorates semantic roles and avoids generic/none duplicates", () => {
    const ids = new Set([10]);
    expect(decorateRoleIfScrollable("button", 10, ids)).toBe(
      "scrollable, button"
    );
    expect(decorateRoleIfScrollable("generic", 10, ids)).toBe("scrollable");
    expect(decorateRoleIfScrollable("none", 10, ids)).toBe("scrollable");
    expect(decorateRoleIfScrollable("button", 9, ids)).toBe("button");
  });
});
