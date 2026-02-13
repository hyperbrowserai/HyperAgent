import { executeReplaySpecialAction } from "@/agent/shared/replay-special-actions";
import type { Page } from "playwright-core";

jest.mock("@/utils/waitForSettledDOM", () => ({
  waitForSettledDOM: jest.fn(),
}));

jest.mock("@/context-providers/a11y-dom/dom-cache", () => ({
  markDomSnapshotDirty: jest.fn(),
}));

const { waitForSettledDOM } = jest.requireMock(
  "@/utils/waitForSettledDOM"
) as {
  waitForSettledDOM: jest.Mock;
};

const { markDomSnapshotDirty } = jest.requireMock(
  "@/context-providers/a11y-dom/dom-cache"
) as {
  markDomSnapshotDirty: jest.Mock;
};

function createPage(overrides?: Record<string, unknown>) {
  return {
    goto: jest.fn().mockResolvedValue(undefined),
    reload: jest.fn().mockResolvedValue(undefined),
    waitForTimeout: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("executeReplaySpecialAction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    waitForSettledDOM.mockResolvedValue(undefined);
  });

  it("replays goToUrl using actionParams url", async () => {
    const page = createPage();

    const result = await executeReplaySpecialAction({
      taskId: "task-1",
      actionType: "goToUrl",
      actionParams: { url: "https://example.com" },
      page: page as unknown as Page,
    });

    expect(page.goto).toHaveBeenCalledWith("https://example.com", {
      waitUntil: "domcontentloaded",
    });
    expect(waitForSettledDOM).toHaveBeenCalledWith(page);
    expect(markDomSnapshotDirty).toHaveBeenCalledWith(page);
    expect(result?.status).toBe("completed");
  });

  it("replays wait using duration from actionParams", async () => {
    const page = createPage();

    const result = await executeReplaySpecialAction({
      taskId: "task-2",
      actionType: "wait",
      actionParams: { duration: "1500" },
      page: page as unknown as Page,
    });

    expect(page.waitForTimeout).toHaveBeenCalledWith(1500);
    expect(result?.output).toBe("Waited 1500ms");
  });

  it("fails extract replay when instruction is missing", async () => {
    const page = createPage({
      extract: jest.fn(),
    });

    const result = await executeReplaySpecialAction({
      taskId: "task-3",
      actionType: "extract",
      page: page as unknown as Page,
    });

    expect(result?.status).toBe("failed");
    expect(result?.output).toContain("Missing objective/instruction");
  });

  it("returns null for non-special actions", async () => {
    const page = createPage();

    const result = await executeReplaySpecialAction({
      taskId: "task-4",
      actionType: "actElement",
      page: page as unknown as Page,
    });

    expect(result).toBeNull();
  });
});
