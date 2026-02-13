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
});
