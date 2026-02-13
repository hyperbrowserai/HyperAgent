import { buildActionCacheEntry } from "@/agent/shared/action-cache";
import { createScriptFromActionCache } from "@/agent/shared/action-cache-script";
import type { ActionOutput, ActionType } from "@/types";
import type { A11yDOMState } from "@/context-providers/a11y-dom/types";
import type { ActionCacheEntry } from "@/types/agent/types";

describe("action cache helpers", () => {
  it("normalizes goToUrl cache arguments from action params", () => {
    const action = {
      type: "goToUrl",
      params: {
        url: "https://example.com",
      },
    } as unknown as ActionType;
    const actionOutput: ActionOutput = {
      success: true,
      message: "ok",
    };
    const domState: A11yDOMState = {
      elements: new Map(),
      domState: "",
      xpathMap: {},
      backendNodeMap: {},
    };

    const entry = buildActionCacheEntry({
      stepIndex: 0,
      action,
      actionOutput,
      domState,
    });

    expect(entry.arguments).toEqual(["https://example.com"]);
  });

  it("uses actionParams url when goToUrl argument is whitespace", () => {
    const goToEntry: ActionCacheEntry = {
      stepIndex: 1,
      instruction: "navigate",
      elementId: null,
      method: null,
      arguments: ["   "],
      actionType: "goToUrl",
      success: true,
      message: "ok",
      frameIndex: null,
      xpath: null,
      actionParams: {
        url: "https://example.org",
      },
    };

    const script = createScriptFromActionCache({
      steps: [goToEntry],
    });

    expect(script).toContain('"https://example.org"');
  });

  it("trims goToUrl argument before script generation", () => {
    const goToEntry: ActionCacheEntry = {
      stepIndex: 9,
      instruction: "navigate",
      elementId: null,
      method: null,
      arguments: ["  https://trimmed.example  "],
      actionType: "goToUrl",
      success: true,
      message: "ok",
      frameIndex: null,
      xpath: null,
    };

    const script = createScriptFromActionCache({
      steps: [goToEntry],
    });

    expect(script).toContain('"https://trimmed.example"');
    expect(script).not.toContain('"  https://trimmed.example  "');
  });

  it("renders wait script timeout from numeric actionParams duration", () => {
    const waitEntry: ActionCacheEntry = {
      stepIndex: 2,
      instruction: "wait a bit",
      elementId: null,
      method: null,
      arguments: [],
      actionType: "wait",
      success: true,
      message: "ok",
      frameIndex: null,
      xpath: null,
      actionParams: {
        duration: 2500,
      },
    };

    const script = createScriptFromActionCache({
      steps: [waitEntry],
    });

    expect(script).toContain("waitForTimeout(2500)");
  });

  it("renders wait script timeout from string duration", () => {
    const waitEntry: ActionCacheEntry = {
      stepIndex: 5,
      instruction: "wait from string",
      elementId: null,
      method: null,
      arguments: [],
      actionType: "wait",
      success: true,
      message: "ok",
      frameIndex: null,
      xpath: null,
      actionParams: {
        duration: "700",
      },
    };

    const script = createScriptFromActionCache({
      steps: [waitEntry],
    });

    expect(script).toContain("waitForTimeout(700)");
  });

  it("preserves zero wait duration when explicitly provided", () => {
    const waitEntry: ActionCacheEntry = {
      stepIndex: 6,
      instruction: "wait zero",
      elementId: null,
      method: null,
      arguments: ["0"],
      actionType: "wait",
      success: true,
      message: "ok",
      frameIndex: null,
      xpath: null,
    };

    const script = createScriptFromActionCache({
      steps: [waitEntry],
    });

    expect(script).toContain("waitForTimeout(0)");
  });

  it("normalizes negative wait durations to default timeout", () => {
    const waitEntry: ActionCacheEntry = {
      stepIndex: 8,
      instruction: "wait negative",
      elementId: null,
      method: null,
      arguments: ["-10"],
      actionType: "wait",
      success: true,
      message: "ok",
      frameIndex: null,
      xpath: null,
    };

    const script = createScriptFromActionCache({
      steps: [waitEntry],
    });

    expect(script).toContain("waitForTimeout(1000)");
  });

  it("renders waitForLoadState script with timeout when provided", () => {
    const waitEntry: ActionCacheEntry = {
      stepIndex: 12,
      instruction: "wait for network idle",
      elementId: null,
      method: null,
      arguments: ["networkidle", "2500"],
      actionType: "waitForLoadState",
      success: true,
      message: "ok",
      frameIndex: null,
      xpath: null,
    };

    const script = createScriptFromActionCache({
      steps: [waitEntry],
    });

    expect(script).toContain(
      'await page.waitForLoadState("networkidle", { timeout: 2500 });'
    );
  });

  it("renders waitForLoadState script defaulting to domcontentloaded", () => {
    const waitEntry: ActionCacheEntry = {
      stepIndex: 13,
      instruction: "wait default",
      elementId: null,
      method: null,
      arguments: [],
      actionType: "waitForLoadState",
      success: true,
      message: "ok",
      frameIndex: null,
      xpath: null,
    };

    const script = createScriptFromActionCache({
      steps: [waitEntry],
    });

    expect(script).toContain('await page.waitForLoadState("domcontentloaded");');
  });

  it("normalizes unsupported waitForLoadState targets to domcontentloaded", () => {
    const waitEntry: ActionCacheEntry = {
      stepIndex: 14,
      instruction: "wait unsupported",
      elementId: null,
      method: null,
      arguments: ["interactive"],
      actionType: "waitForLoadState",
      success: true,
      message: "ok",
      frameIndex: null,
      xpath: null,
    };

    const script = createScriptFromActionCache({
      steps: [waitEntry],
    });

    expect(script).toContain('await page.waitForLoadState("domcontentloaded");');
    expect(script).not.toContain('await page.waitForLoadState("interactive");');
  });

  it("skips helper generation when xpath is missing", () => {
    const actElementEntry: ActionCacheEntry = {
      stepIndex: 3,
      instruction: "click login",
      elementId: "0-10",
      method: "click",
      arguments: [],
      actionType: "actElement",
      success: true,
      message: "ok",
      frameIndex: 0,
      xpath: null,
    };

    const script = createScriptFromActionCache({
      steps: [actElementEntry],
    });

    expect(script).toContain("reason=missing xpath");
    expect(script).not.toContain("await page.performClick(");
  });

  it("skips extract generation when instruction is missing", () => {
    const extractEntry: ActionCacheEntry = {
      stepIndex: 4,
      instruction: undefined,
      elementId: null,
      method: null,
      arguments: [],
      actionType: "extract",
      success: true,
      message: "ok",
      frameIndex: null,
      xpath: null,
    };

    const script = createScriptFromActionCache({
      steps: [extractEntry],
    });

    expect(script).toContain("extract skipped: missing instruction");
    expect(script).not.toContain("await page.extract(");
  });

  it("escapes extract instruction content in generated script", () => {
    const instruction = 'extract "quoted" title\nand subtitle';
    const extractEntry: ActionCacheEntry = {
      stepIndex: 7,
      instruction,
      elementId: null,
      method: null,
      arguments: [],
      actionType: "extract",
      success: true,
      message: "ok",
      frameIndex: null,
      xpath: null,
    };

    const script = createScriptFromActionCache({
      steps: [extractEntry],
    });

    expect(script).toContain(`await page.extract(${JSON.stringify(instruction)});`);
  });

  it("trims extract instruction before script generation", () => {
    const extractEntry: ActionCacheEntry = {
      stepIndex: 10,
      instruction: "  extract headline  ",
      elementId: null,
      method: null,
      arguments: [],
      actionType: "extract",
      success: true,
      message: "ok",
      frameIndex: null,
      xpath: null,
    };

    const script = createScriptFromActionCache({
      steps: [extractEntry],
    });

    expect(script).toContain('await page.extract("extract headline");');
    expect(script).not.toContain('await page.extract("  extract headline  ");');
  });

  it("omits performInstruction option when instruction is whitespace", () => {
    const helperEntry: ActionCacheEntry = {
      stepIndex: 11,
      instruction: "   ",
      elementId: "0-1",
      method: "click",
      arguments: [],
      actionType: "actElement",
      success: true,
      message: "ok",
      frameIndex: 0,
      xpath: "//button[1]",
    };

    const script = createScriptFromActionCache({
      steps: [helperEntry],
    });

    expect(script).toContain("await page.performClick(");
    expect(script).not.toContain("performInstruction");
  });
});
