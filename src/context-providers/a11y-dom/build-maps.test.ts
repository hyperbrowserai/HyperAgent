import { buildBackendIdMaps } from "@/context-providers/a11y-dom/build-maps";
import type { CDPSession } from "@/cdp";

describe("buildBackendIdMaps", () => {
  it("formats non-Error failures when DOM document fetch fails", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const session: CDPSession = {
      id: "session-1",
      raw: undefined,
      send: async <T = unknown>(method: string): Promise<T> => {
        if (method === "DOM.getDocument") {
          throw { reason: "dom document object failure" };
        }
        return {} as T;
      },
      on: jest.fn(),
      off: jest.fn(),
      detach: jest.fn(async () => undefined),
    };

    try {
      const result = await buildBackendIdMaps(session);

      expect(result.tagNameMap).toEqual({});
      expect(result.xpathMap).toEqual({});
      expect(result.accessibleNameMap).toEqual({});
      expect(result.backendNodeMap).toEqual({});
      expect(result.frameMap?.size ?? 0).toBe(0);
      expect(errorSpy).toHaveBeenCalledWith(
        'Error building backend ID maps: {"reason":"dom document object failure"}'
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
