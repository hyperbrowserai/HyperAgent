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
    waitForLoadState: jest.fn().mockResolvedValue(undefined),
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
    expect(result?.replayStepMeta?.retries).toBe(1);
  });

  it("fails goToUrl replay when url is empty after trimming", async () => {
    const page = createPage();

    const result = await executeReplaySpecialAction({
      taskId: "task-empty-url",
      actionType: "goToUrl",
      arguments: ["   "],
      page: page as unknown as Page,
    });

    expect(result?.status).toBe("failed");
    expect(result?.output).toContain("Missing URL for goToUrl");
    expect(page.goto).not.toHaveBeenCalled();
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
    expect(markDomSnapshotDirty).toHaveBeenCalledWith(page);
    expect(result?.output).toBe("Waited 1500ms");
  });

  it("defaults wait duration when parsed value is negative", async () => {
    const page = createPage();

    const result = await executeReplaySpecialAction({
      taskId: "task-6",
      actionType: "wait",
      actionParams: { duration: -5 },
      page: page as unknown as Page,
    });

    expect(page.waitForTimeout).toHaveBeenCalledWith(1000);
    expect(result?.output).toBe("Waited 1000ms");
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

  it("fails extract replay when instruction is only whitespace", async () => {
    const extract = jest.fn();
    const page = createPage({
      extract,
    });

    const result = await executeReplaySpecialAction({
      taskId: "task-7",
      actionType: "extract",
      instruction: "   ",
      page: page as unknown as Page,
    });

    expect(result?.status).toBe("failed");
    expect(result?.output).toContain("Missing objective/instruction");
    expect(extract).not.toHaveBeenCalled();
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

  it("replays waitForLoadState with timeout argument", async () => {
    const page = createPage();

    const result = await executeReplaySpecialAction({
      taskId: "task-loadstate",
      actionType: "waitForLoadState",
      arguments: ["networkidle", 2500],
      page: page as unknown as Page,
    });

    expect(page.waitForLoadState).toHaveBeenCalledWith("networkidle", {
      timeout: 2500,
    });
    expect(waitForSettledDOM).toHaveBeenCalledWith(page);
    expect(markDomSnapshotDirty).toHaveBeenCalledWith(page);
    expect(result?.status).toBe("completed");
    expect(result?.output).toBe("Waited for load state: networkidle");
  });

  it("defaults waitForLoadState to domcontentloaded for unsupported values", async () => {
    const page = createPage();

    const result = await executeReplaySpecialAction({
      taskId: "task-loadstate-invalid",
      actionType: "waitForLoadState",
      arguments: ["interactive"],
      page: page as unknown as Page,
    });

    expect(page.waitForLoadState).toHaveBeenCalledWith("domcontentloaded", undefined);
    expect(result?.status).toBe("completed");
    expect(result?.output).toBe("Waited for load state: domcontentloaded");
  });

  it("normalizes waitForLoadState value case-insensitively", async () => {
    const page = createPage();

    const result = await executeReplaySpecialAction({
      taskId: "task-loadstate-uppercase",
      actionType: "waitForLoadState",
      arguments: ["LOAD"],
      page: page as unknown as Page,
    });

    expect(page.waitForLoadState).toHaveBeenCalledWith("load", undefined);
    expect(result?.status).toBe("completed");
    expect(result?.output).toBe("Waited for load state: load");
  });

  it("parses string timeout for waitForLoadState", async () => {
    const page = createPage();

    await executeReplaySpecialAction({
      taskId: "task-loadstate-timeout-string",
      actionType: "waitForLoadState",
      arguments: ["load", "1800"],
      page: page as unknown as Page,
    });

    expect(page.waitForLoadState).toHaveBeenCalledWith("load", { timeout: 1800 });
  });

  it("uses actionParams fallback for waitForLoadState values", async () => {
    const page = createPage();

    await executeReplaySpecialAction({
      taskId: "task-loadstate-actionparams",
      actionType: "waitForLoadState",
      actionParams: {
        waitUntil: "networkidle",
        timeout: 2200,
      },
      page: page as unknown as Page,
    });

    expect(page.waitForLoadState).toHaveBeenCalledWith("networkidle", {
      timeout: 2200,
    });
  });

  it("omits negative waitForLoadState timeout values", async () => {
    const page = createPage();

    await executeReplaySpecialAction({
      taskId: "task-loadstate-negative-timeout",
      actionType: "waitForLoadState",
      arguments: ["load", -1],
      page: page as unknown as Page,
    });

    expect(page.waitForLoadState).toHaveBeenCalledWith("load", undefined);
  });

  it("continues waitForLoadState replay when settle wait fails", async () => {
    const page = createPage();
    waitForSettledDOM.mockRejectedValueOnce(new Error("settle failed"));

    const result = await executeReplaySpecialAction({
      taskId: "task-loadstate-settle-fail",
      actionType: "waitForLoadState",
      arguments: ["load"],
      page: page as unknown as Page,
    });

    expect(page.waitForLoadState).toHaveBeenCalledWith("load", undefined);
    expect(result?.status).toBe("completed");
    expect(result?.output).toBe("Waited for load state: load");
  });

  it("fails extract replay when extracted object cannot be serialized", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const extract = jest.fn().mockResolvedValue(circular);
    const page = createPage({
      extract,
    });

    const result = await executeReplaySpecialAction({
      taskId: "task-circular-extract",
      actionType: "extract",
      instruction: "extract circular object",
      page: page as unknown as Page,
    });

    expect(result?.status).toBe("failed");
    expect(result?.output).toContain("could not serialize extracted output");
  });

  it("fails extract replay when serialization returns undefined", async () => {
    const extract = jest.fn().mockResolvedValue(undefined);
    const page = createPage({
      extract,
    });

    const result = await executeReplaySpecialAction({
      taskId: "task-undefined-extract",
      actionType: "extract",
      instruction: "extract undefined",
      page: page as unknown as Page,
    });

    expect(result?.status).toBe("failed");
    expect(result?.output).toContain("could not serialize extracted output");
  });

  it("formats object-thrown extract errors as readable JSON", async () => {
    const extract = jest.fn().mockRejectedValue({ reason: "bad extract" });
    const page = createPage({
      extract,
    });

    const result = await executeReplaySpecialAction({
      taskId: "task-object-error-extract",
      actionType: "extract",
      instruction: "extract info",
      page: page as unknown as Page,
    });

    expect(result?.status).toBe("failed");
    expect(result?.output).toContain('Extract failed: {"reason":"bad extract"}');
  });

  it("honors explicit retry metadata value", async () => {
    const page = createPage();

    const result = await executeReplaySpecialAction({
      taskId: "task-5",
      actionType: "complete",
      page: page as unknown as Page,
      retries: 3,
    });

    expect(result?.replayStepMeta?.retries).toBe(3);
  });
});
