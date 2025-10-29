import { z } from "zod";
import { ActionContext, ActionOutput, AgentActionDefinition } from "@/types";

export const generateCompleteActionWithOutputDefinition = (
  outputSchema: z.ZodType<any>
): AgentActionDefinition => {
  const actionParamsSchema = z
    .object({
      success: z
        .boolean()
        .describe("Whether the task was completed successfully."),
      outputSchema: outputSchema
        .nullable()
        .describe(
          "The output model to return the response in. Given the previous data, try your best to fit the final response into the given schema."
        ),
    })
    .describe(
      "Complete the task. An output schema has been provided to you. Try your best to provide your response so that it fits the output schema provided."
    );

  type CompeleteActionWithOutputSchema = z.infer<typeof actionParamsSchema>;

  return {
    type: "complete" as const,
    actionParams: actionParamsSchema,
    run: async (
      ctx: ActionContext,
      actionParams: CompeleteActionWithOutputSchema
    ): Promise<ActionOutput> => {
      if (actionParams.success && actionParams.outputSchema) {
        return {
          success: true,
          message: "The action generated an object",
          extract: actionParams.outputSchema,
        };
      } else {
        return {
          success: false,
          message:
            "Could not complete task and/or could not extract response into output schema.",
        };
      }
    },
    completeAction: async (params: CompeleteActionWithOutputSchema) => {
      return JSON.stringify(params.outputSchema, null, 2);
    },
  };
};
