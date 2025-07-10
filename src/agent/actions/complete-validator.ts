import { z } from "zod";
import { ActionContext, ActionOutput, AgentActionDefinition } from "@/types";

export const CompletionValidateAction = z
  .object({
    task: z
      .string()
      .describe("The detailed description of the task to complete."),
    completionCriteria: z.array(
      z.object({
        subTask: z
          .string()
          .describe("The description of the specific sub task of the task."),
        subTaskSatisfied: z
          .boolean()
          .describe("Is the specific sub task of the task completed."),
        subTaskSatisfiedReason: z
          .string()
          .describe(
            "How and why has this subtask been marked as completed (if completed). Provide the result as well if this response required an action, and that action produced a result.",
          ),
      }),
    ),
  })
  .describe(
    `Must run this before issuing the final complete action to validate that the task is completed.
    Evaluate if all the sub parts of the task are completed, and so if the task itself is completed. If you don't run this step, you will be heavily penalized.`,
  );

export type CompleteValidateActionType = z.infer<
  typeof CompletionValidateAction
>;

export const CompletionValidateActionDefinition: AgentActionDefinition = {
  type: "taskCompleteValidation",
  actionParams: CompletionValidateAction,

  run: async (
    ctx: ActionContext,
    action: CompleteValidateActionType,
  ): Promise<ActionOutput> => {
    const completionCriteria = action.completionCriteria
      .map(
        (subTask) =>
          `subTask:${subTask.subTask} || condition satisfied: ${subTask.subTaskSatisfied}`,
      )
      .join("\n");
    return {
      success: true,
      message: `Task Completion Report: \ntask:${action.task} \nsubtasks: \n${completionCriteria}`,
    };
  },

  generateCode: async (
    ctx: ActionContext,
    action: CompleteValidateActionType,
  ) => {
    const completionCriteria = action.completionCriteria
      .map(
        (subTask) =>
          `subTask:${subTask.subTask} || condition satisfied: ${subTask.subTaskSatisfied}`,
      )
      .join("\n");
    return `Task Completion Report: \ntask:${action.task} \nsubtasks: \n${completionCriteria}`;
  },
};
