import type { Page } from "playwright-core";
import { executePlaywrightMethod } from "@/agent/shared/execute-playwright-method";

type LocatorLike = ReturnType<Page["locator"]>;

function createMockLocator(overrides?: Partial<Record<string, jest.Mock>>): LocatorLike {
  return {
    click: jest.fn().mockResolvedValue(undefined),
    evaluate: jest.fn().mockResolvedValue(undefined),
    fill: jest.fn().mockResolvedValue(undefined),
    selectOption: jest.fn().mockResolvedValue(undefined),
    hover: jest.fn().mockResolvedValue(undefined),
    press: jest.fn().mockResolvedValue(undefined),
    check: jest.fn().mockResolvedValue(undefined),
    uncheck: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as LocatorLike;
}

describe("executePlaywrightMethod", () => {
  it("formats non-Error click fallback failures with readable output", async () => {
    const locator = createMockLocator({
      click: jest.fn().mockRejectedValue({ reason: "click failed" }),
      evaluate: jest.fn().mockRejectedValue({ reason: "js click failed" }),
    });

    await expect(
      executePlaywrightMethod("click", [], locator, { debug: true })
    ).rejects.toThrow(
      'Failed to click element. Playwright error: {"reason":"click failed"}. JS click error: {"reason":"js click failed"}'
    );
  });

  it("does not crash debug logging on circular method args", async () => {
    const circular: Record<string, unknown> = { id: "arg" };
    circular.self = circular;
    const locator = createMockLocator();
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(
        executePlaywrightMethod("hover", [circular], locator, { debug: true })
      ).resolves.toBeUndefined();

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('"self":"[Circular]"')
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("preserves explicit zero for scrollToPercentage target", async () => {
    const evaluateSpy = jest.fn().mockResolvedValue(undefined);
    const locator = createMockLocator({
      evaluate: evaluateSpy,
    });

    await executePlaywrightMethod("scrollToPercentage", [0], locator);

    expect(evaluateSpy).toHaveBeenCalled();
    const call = evaluateSpy.mock.calls[0];
    expect(call?.[1]).toEqual({ yArg: "0" });
  });

  it("preserves numeric zero values for fill and selectOption actions", async () => {
    const fillSpy = jest.fn().mockResolvedValue(undefined);
    const selectSpy = jest.fn().mockResolvedValue(undefined);
    const locator = createMockLocator({
      fill: fillSpy,
      selectOption: selectSpy,
    });

    await executePlaywrightMethod("fill", [0], locator);
    await executePlaywrightMethod("selectOptionFromDropdown", [0], locator);

    expect(fillSpy).toHaveBeenCalledWith("0");
    expect(selectSpy).toHaveBeenCalledWith("0");
  });

  it("falls back to Enter when press key is empty string", async () => {
    const pressSpy = jest.fn().mockResolvedValue(undefined);
    const locator = createMockLocator({
      press: pressSpy,
    });

    await executePlaywrightMethod("press", [""], locator);

    expect(pressSpy).toHaveBeenCalledWith("Enter");
  });
});
