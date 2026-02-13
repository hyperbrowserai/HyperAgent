import { z } from "zod";
import { generateCompleteActionWithOutputDefinition } from "@/agent/actions/complete-with-output-schema";
import type { ActionContext } from "@/types";

describe("generateCompleteActionWithOutputDefinition", () => {
  const ctx = {} as ActionContext;

  it("returns success output when completion is successful with schema payload", async () => {
    const definition = generateCompleteActionWithOutputDefinition(
      z.object({
        title: z.string(),
      })
    );

    const result = await definition.run(ctx, {
      success: true,
      outputSchema: {
        title: "done",
      },
    });

    expect(result.success).toBe(true);
    expect(result.extract).toEqual({ title: "done" });
  });

  it("returns failure output when completion flag is false", async () => {
    const definition = generateCompleteActionWithOutputDefinition(
      z.object({
        title: z.string(),
      })
    );

    const result = await definition.run(ctx, {
      success: false,
      outputSchema: {
        title: "done",
      },
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Could not complete task");
  });

  it("stringifies completion output schema payload", async () => {
    const definition = generateCompleteActionWithOutputDefinition(
      z.object({
        title: z.string(),
      })
    );

    const output = await definition.completeAction?.({
      success: true,
      outputSchema: {
        title: "done",
      },
    });

    expect(output).toContain('"title": "done"');
  });

  it("returns failure when success is truthy but not boolean true", async () => {
    const definition = generateCompleteActionWithOutputDefinition(
      z.object({
        title: z.string(),
      })
    );

    const result = await definition.run(ctx, {
      success: "true" as unknown as boolean,
      outputSchema: {
        title: "done",
      },
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Could not complete task");
  });

  it("handles trap-prone outputSchema getters gracefully", async () => {
    const definition = generateCompleteActionWithOutputDefinition(
      z.object({
        title: z.string(),
      })
    );

    const result = await definition.run(ctx, {
      success: true,
      get outputSchema() {
        throw new Error("output schema trap");
      },
    } as unknown as Parameters<typeof definition.run>[1]);

    expect(result.success).toBe(false);
    expect(result.message).toContain("Could not complete task");
  });

  it("serializes circular completion payloads safely", async () => {
    const definition = generateCompleteActionWithOutputDefinition(
      z.object({
        title: z.string(),
      })
    );

    const circular: Record<string, unknown> = { title: "done" };
    circular.self = circular;

    const output = await definition.completeAction?.({
      success: true,
      outputSchema: circular,
    });

    expect(output).toContain("[Circular]");
  });

  it("truncates oversized completion payload output", async () => {
    const definition = generateCompleteActionWithOutputDefinition(
      z.object({
        title: z.string(),
      })
    );

    const output = await definition.completeAction?.({
      success: true,
      outputSchema: {
        title: "x".repeat(30_000),
      },
    });

    expect(output).toContain("[truncated");
    expect(output?.length ?? 0).toBeLessThan(21_000);
  });
});
