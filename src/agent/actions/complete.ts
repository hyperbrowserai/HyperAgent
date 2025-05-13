import { z } from "zod";
import { ActionOutput, AgentActionDefinition } from "@/types";

export const CompleteAction = z
  .object({
    success: z
      .boolean()
      .describe("Whether the task was completed successfully."),
    text: z
      .string()
      .nullable()
      .describe(
        "The text to complete the task with, make this answer the ultimate goal of the task. Be sure to include all the information requested in the task in explicit detail."
      ),
  })
  .describe("Complete the task, this must be the final action in the sequence");

export type CompleteActionType = z.infer<typeof CompleteAction>;

export const CompleteActionDefinition: AgentActionDefinition<
  typeof CompleteAction
> = {
  type: "complete" as const,
  shouldIgnoreActionForScan: true,
  actionParams: CompleteAction,
  run: async (): Promise<ActionOutput> => {
    return { success: true, message: "Task Complete" };
  },
  completeAction: async (params: CompleteActionType) => {
    return params.text ?? "No response text found";
  },
  pprintAction: function (params: CompleteActionType): string {
    return `Complete task with ${params.success ? "success" : "failure"}`;
  },
};
