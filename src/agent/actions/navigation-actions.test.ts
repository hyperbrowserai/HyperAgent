import type { Page } from "playwright-core";
import type { ActionContext } from "@/types";
import { GoToURLActionDefinition } from "@/agent/actions/go-to-url";
import { WaitActionDefinition } from "@/agent/actions/wait";
import { RefreshPageActionDefinition } from "@/agent/actions/refresh-page";
import { ScrollActionDefinition } from "@/agent/actions/scroll";
import { PageBackActionDefinition } from "@/agent/actions/page-back";
import { PageForwardActionDefinition } from "@/agent/actions/page-forward";

jest.mock("@/utils/waitForSettledDOM", () => ({
  waitForSettledDOM: jest.fn(),
}));

const { waitForSettledDOM } = jest.requireMock("@/utils/waitForSettledDOM") as {
  waitForSettledDOM: jest.Mock;
};

function createContext(overrides?: Partial<ActionContext>): ActionContext {
  const page = {
    goto: jest.fn().mockResolvedValue(undefined),
    reload: jest.fn().mockResolvedValue(undefined),
    evaluate: jest.fn().mockResolvedValue(undefined),
    goBack: jest.fn().mockResolvedValue({}),
    goForward: jest.fn().mockResolvedValue({}),
  } as unknown as Page;

  return {
    page,
    domState: {
      elements: new Map(),
      domState: "",
      xpathMap: {},
      backendNodeMap: {},
    },
    llm: {
      invoke: async () => ({ role: "assistant", content: "ok" }),
      invokeStructured: async () => ({ rawText: "{}", parsed: null }),
      getProviderId: () => "mock",
      getModelId: () => "mock-model",
      getCapabilities: () => ({
        multimodal: false,
        toolCalling: true,
        jsonMode: true,
      }),
    },
    tokenLimit: 10000,
    variables: [],
    invalidateDomCache: jest.fn(),
    ...overrides,
  };
}

describe("navigation and wait actions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    waitForSettledDOM.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("navigates to URL and invalidates DOM cache", async () => {
    const ctx = createContext();

    const result = await GoToURLActionDefinition.run(ctx, {
      url: "  https://example.com/app  ",
    });

    expect(result.success).toBe(true);
    expect((ctx.page.goto as jest.Mock)).toHaveBeenCalledWith(
      "https://example.com/app"
    );
    expect(ctx.invalidateDomCache).toHaveBeenCalledTimes(1);
  });

  it("returns failure when page.goto is unavailable", async () => {
    const ctx = createContext({
      page: {
        goto: undefined,
      } as unknown as Page,
    });

    const result = await GoToURLActionDefinition.run(ctx, {
      url: "https://example.com",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("page.goto is unavailable");
  });

  it("waits for settled DOM and preserves normalized reason", async () => {
    jest.useFakeTimers();
    const ctx = createContext();

    const runPromise = WaitActionDefinition.run(ctx, {
      reason: "  waiting for content   to appear ",
    });

    await jest.advanceTimersByTimeAsync(1_000);
    const result = await runPromise;

    expect(waitForSettledDOM).toHaveBeenCalledWith(ctx.page);
    expect(result.success).toBe(true);
    expect(result.message).toContain("waiting for content to appear");
    expect(ctx.invalidateDomCache).toHaveBeenCalledTimes(1);
  });

  it("returns failure when waitForSettledDOM fails", async () => {
    waitForSettledDOM.mockRejectedValue(new Error("settle failed"));
    const ctx = createContext();

    const result = await WaitActionDefinition.run(ctx, {
      reason: "loading",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("settle failed");
  });

  it("refreshes page and reports unavailable reload method", async () => {
    const okCtx = createContext();
    const okResult = await RefreshPageActionDefinition.run(okCtx, {});
    expect(okResult.success).toBe(true);
    expect(okResult.message).toContain("Successfully refreshed the page");

    const badCtx = createContext({
      page: { reload: null } as unknown as Page,
    });
    const badResult = await RefreshPageActionDefinition.run(badCtx, {});
    expect(badResult.success).toBe(false);
    expect(badResult.message).toContain("page.reload is unavailable");
  });

  it("handles history navigation null responses gracefully", async () => {
    const backCtx = createContext({
      page: {
        goBack: jest.fn().mockResolvedValue(null),
      } as unknown as Page,
    });
    const backResult = await PageBackActionDefinition.run(backCtx, {});
    expect(backResult.success).toBe(true);
    expect(backResult.message).toContain("No previous page in browser history");

    const forwardCtx = createContext({
      page: {
        goForward: jest.fn().mockResolvedValue(null),
      } as unknown as Page,
    });
    const forwardResult = await PageForwardActionDefinition.run(forwardCtx, {});
    expect(forwardResult.success).toBe(true);
    expect(forwardResult.message).toContain("No next page in browser history");
  });

  it("returns failure for unsupported scroll directions and evaluate errors", async () => {
    const unsupportedCtx = createContext();
    const unsupported = await ScrollActionDefinition.run(
      unsupportedCtx,
      { direction: "diagonal" as unknown as "up" }
    );
    expect(unsupported.success).toBe(false);
    expect(unsupported.message).toContain("unsupported direction");

    const failingCtx = createContext({
      page: {
        evaluate: jest.fn().mockRejectedValue(new Error("scroll failed")),
      } as unknown as Page,
    });
    const failing = await ScrollActionDefinition.run(failingCtx, {
      direction: "down",
    });
    expect(failing.success).toBe(false);
    expect(failing.message).toContain("scroll failed");
  });
});
