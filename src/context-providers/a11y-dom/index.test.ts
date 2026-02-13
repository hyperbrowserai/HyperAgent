import type { Page } from "playwright-core";
import { getA11yDOM } from "@/context-providers/a11y-dom";

describe("getA11yDOM error formatting", () => {
  it("formats non-Error failures from script injection and returns fallback state", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const page = {
      evaluate: jest.fn().mockRejectedValue({ reason: "inject failed" }),
    } as unknown as Page;

    try {
      const result = await getA11yDOM(page);

      expect(result.domState).toBe("Error: Could not extract accessibility tree");
      expect(result.elements.size).toBe(0);
      expect(result.frameMap?.size ?? 0).toBe(0);
      expect(errorSpy).toHaveBeenCalledWith(
        'Error extracting accessibility tree: {"reason":"inject failed"}'
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
