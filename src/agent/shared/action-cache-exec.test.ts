import {
  dispatchPerformHelper,
  isPageActionMethod,
} from "@/agent/shared/action-cache-exec";
import type { HyperPage } from "@/types/agent/types";

function createMockHyperPage(): HyperPage {
  const ok = Promise.resolve({
    taskId: "task-id",
    status: "completed",
    steps: [],
    output: "ok",
  });
  return {
    performClick: jest.fn().mockReturnValue(ok),
    performHover: jest.fn().mockReturnValue(ok),
    performType: jest.fn().mockReturnValue(ok),
    performFill: jest.fn().mockReturnValue(ok),
    performPress: jest.fn().mockReturnValue(ok),
    performSelectOption: jest.fn().mockReturnValue(ok),
    performCheck: jest.fn().mockReturnValue(ok),
    performUncheck: jest.fn().mockReturnValue(ok),
    performScrollToElement: jest.fn().mockReturnValue(ok),
    performScrollToPercentage: jest.fn().mockReturnValue(ok),
    performNextChunk: jest.fn().mockReturnValue(ok),
    performPrevChunk: jest.fn().mockReturnValue(ok),
  } as unknown as HyperPage;
}

describe("action-cache perform helper dispatch", () => {
  it("validates known page action methods", () => {
    expect(isPageActionMethod("click")).toBe(true);
    expect(isPageActionMethod("not-a-method")).toBe(false);
  });

  it("dispatches fill with value argument", async () => {
    const page = createMockHyperPage();
    const options = { maxSteps: 2 };

    await dispatchPerformHelper(page, "fill", "//input[1]", "hello", options);

    expect(page.performFill).toHaveBeenCalledWith("//input[1]", "hello", {
      maxSteps: 2,
    });
  });

  it("dispatches click without value argument", async () => {
    const page = createMockHyperPage();
    const options = { maxSteps: 1 };

    await dispatchPerformHelper(page, "click", "//button[1]", undefined, options);

    expect(page.performClick).toHaveBeenCalledWith("//button[1]", {
      maxSteps: 1,
    });
  });
});
