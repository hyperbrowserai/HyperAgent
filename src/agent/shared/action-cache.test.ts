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
});
