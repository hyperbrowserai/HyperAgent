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
});
