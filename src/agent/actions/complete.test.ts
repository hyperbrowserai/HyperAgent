import { CompleteActionDefinition } from "@/agent/actions/complete";
import type { ActionContext } from "@/types";

describe("CompleteActionDefinition", () => {
  const ctx = {} as ActionContext;

  it("returns success output when params.success is true", async () => {
    const result = await CompleteActionDefinition.run(ctx, {
      success: true,
      text: "final answer",
    });

    expect(result.success).toBe(true);
    expect(result.message).toBe("Task Complete");
  });

  it("returns failed output when params.success is false", async () => {
    const result = await CompleteActionDefinition.run(ctx, {
      success: false,
      text: "final answer",
    });

    expect(result.success).toBe(false);
    expect(result.message).toBe("Task marked as failed");
  });

  it("normalizes non-boolean success values to false", async () => {
    const result = await CompleteActionDefinition.run(ctx, {
      success: "yes" as unknown as boolean,
      text: "final answer",
    });

    expect(result.success).toBe(false);
    expect(result.message).toBe("Task marked as failed");
  });

  it("returns fallback text when response text is null", async () => {
    const output = await CompleteActionDefinition.completeAction?.({
      success: true,
      text: null,
    });

    expect(output).toBe("No response text found");
  });

  it("handles trap-prone text getters safely", async () => {
    const output = await CompleteActionDefinition.completeAction?.({
      success: true,
      get text(): string | null {
        throw new Error("text getter trap");
      },
    } as unknown as Parameters<NonNullable<typeof CompleteActionDefinition.completeAction>>[0]);

    expect(output).toContain("No response text found");
  });

  it("truncates oversized completion text output", async () => {
    const output = await CompleteActionDefinition.completeAction?.({
      success: true,
      text: "x".repeat(30_000),
    });

    expect(output).toContain("[truncated");
    expect((output ?? "").length).toBeLessThan(20_500);
  });
});
