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
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      let thrown: unknown;
      try {
        await executePlaywrightMethod("click", [], locator, { debug: true });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeDefined();
      const message = (thrown as Error).message;
      expect(message).toContain("Failed to click element. Playwright error:");
      expect(message).toContain("locator.click failed");
      expect(message).toContain("locator.evaluate failed");
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Playwright click failed, falling back to JS click: [executePlaywrightMethod] locator.click failed"
        )
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("truncates oversized click fallback diagnostics", async () => {
    const locator = createMockLocator({
      click: jest
        .fn()
        .mockRejectedValue(new Error(`x${"y".repeat(2_000)}\nclick failed`)),
      evaluate: jest
        .fn()
        .mockRejectedValue(new Error(`x${"y".repeat(2_000)}\njs click failed`)),
    });

    await expect(
      executePlaywrightMethod("click", [], locator, { debug: true })
    ).rejects.toThrow(/\[truncated/);
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

  it("rejects non-array args with readable message", async () => {
    const locator = createMockLocator();

    await expect(
      executePlaywrightMethod(
        "click",
        null as unknown as unknown[],
        locator
      )
    ).rejects.toThrow("[executePlaywrightMethod] args must be an array");
  });

  it("handles locator method getter traps with readable diagnostics", async () => {
    const locator = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "press") {
            throw new Error("press getter trap");
          }
          return undefined;
        },
      }
    ) as unknown as LocatorLike;

    await expect(
      executePlaywrightMethod("press", ["Enter"], locator)
    ).rejects.toThrow(
      "[executePlaywrightMethod] Failed to access locator.press: press getter trap"
    );
  });

  it("falls back to Enter when key coercion throws", async () => {
    const pressSpy = jest.fn().mockResolvedValue(undefined);
    const locator = createMockLocator({
      press: pressSpy,
    });
    const badValue = {
      toString(): string {
        throw new Error("coercion trap");
      },
    };

    await executePlaywrightMethod("press", [badValue], locator);

    expect(pressSpy).toHaveBeenCalledWith("Enter");
  });

  it("normalizes clickTimeout bounds for click actions", async () => {
    const clickSpy = jest.fn().mockResolvedValue(undefined);
    const locator = createMockLocator({
      click: clickSpy,
    });

    await executePlaywrightMethod("click", [], locator, {
      clickTimeout: -1,
    });
    await executePlaywrightMethod("click", [], locator, {
      clickTimeout: 999_999,
    });

    expect(clickSpy).toHaveBeenNthCalledWith(1, { timeout: 3500 });
    expect(clickSpy).toHaveBeenNthCalledWith(2, { timeout: 120000 });
  });

  it("caps oversized text arguments before forwarding to fill", async () => {
    const fillSpy = jest.fn().mockResolvedValue(undefined);
    const locator = createMockLocator({
      fill: fillSpy,
    });
    const huge = "x".repeat(25_000);

    await executePlaywrightMethod("fill", [huge], locator);

    expect(fillSpy).toHaveBeenCalled();
    expect((fillSpy.mock.calls[0]?.[0] as string).length).toBe(20_000);
  });

  it("truncates unknown-method diagnostics for oversized non-string values", async () => {
    const locator = createMockLocator();
    const badMethod = `method-${"x".repeat(2_000)}\nunsafe`;

    await expect(
      executePlaywrightMethod(
        badMethod as unknown as string,
        [],
        locator
      )
    ).rejects.toThrow(/\[truncated/);
  });
});
