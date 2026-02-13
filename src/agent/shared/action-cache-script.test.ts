import { createScriptFromActionCache } from "@/agent/shared/action-cache-script";
import type { ActionCacheEntry } from "@/types/agent/types";

function createStep(
  stepIndex: number,
  overrides: Partial<ActionCacheEntry> = {}
): ActionCacheEntry {
  return {
    stepIndex,
    instruction: `step-${stepIndex}`,
    elementId: null,
    method: null,
    arguments: [],
    frameIndex: null,
    xpath: null,
    actionType: "unknown-action",
    success: true,
    message: "cached",
    ...overrides,
  };
}

describe("createScriptFromActionCache hardening", () => {
  it("truncates oversized script step lists to bounded limits", () => {
    const steps = Array.from({ length: 1002 }, (_, index) =>
      createStep(index, { actionType: "complete" })
    );

    const script = createScriptFromActionCache({
      taskId: "task-1",
      steps,
    });

    expect(script).toContain(
      "Script truncated after 1000 steps; 2 additional step(s) were skipped"
    );
    expect(script).toContain("// Step 999 (complete skipped in script)");
    expect(script).not.toContain("// Step 1001 (complete skipped in script)");
  });

  it("sanitizes oversized unsupported action identifiers", () => {
    const script = createScriptFromActionCache({
      taskId: "task-2",
      steps: [
        createStep(0, {
          actionType: `action-${"x".repeat(300)}\u0007`,
          method: `method-${"y".repeat(300)}\u0007`,
          xpath: null,
        }),
      ],
    });

    const unsupportedLine = script
      .split("\n")
      .find((line) => line.includes("unsupported actionType="));
    expect(unsupportedLine).toBeDefined();
    expect(unsupportedLine).toContain("[truncated");
    expect(unsupportedLine).not.toContain("\u0007");
  });

  it("sanitizes oversized goToUrl arguments in generated script", () => {
    const script = createScriptFromActionCache({
      taskId: "task-3",
      steps: [
        createStep(0, {
          actionType: "goToUrl",
          arguments: [`https://example.com/${"x".repeat(5_000)}\nunsafe`],
        }),
      ],
    });

    expect(script).toContain("await page.goto(");
    expect(script).toContain("[truncated");
    expect(script).not.toContain("\\nunsafe");
  });

  it("handles trap-prone stepIndex getters when sorting script steps", () => {
    const trapStep = new Proxy(createStep(99, { actionType: "complete" }), {
      get(target, prop, receiver): unknown {
        if (prop === "stepIndex") {
          throw new Error("stepIndex trap");
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const script = createScriptFromActionCache({
      taskId: "task-4",
      steps: [trapStep as unknown as ActionCacheEntry, createStep(1, { actionType: "complete" })],
    });

    expect(script).toContain("// Step 1 (complete skipped in script)");
    expect(script).toContain("// Step -1 (complete skipped in script)");
  });
});

