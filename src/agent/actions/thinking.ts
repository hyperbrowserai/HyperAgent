import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";

export const ThinkingAction = z
  .object({
    plan: z
      .string()
      .describe(
        "Describe your strategic plan for the next steps, including potential obstacles and how you'll tackle them."
      ),
  })
  .required()
  .describe(
    `Think about a course of action. Think what your current task is, what your next should be, and how you would possibly do that. This step is especially useful if performing a complex task, and/or working on a visually complex page (think nodes > 300).`
  );

export type ThinkingActionType = z.infer<typeof ThinkingAction>;

export const ThinkingActionDefinition: AgentActionDefinition = {
  type: "thinking" as const,
  actionParams: ThinkingAction,
  run: async (ctx: ActionContext, action: ThinkingActionType) => {
    const { plan } = action;
    return {
      success: true,
      message: `A simple thought process about your next steps. You planned: ${plan}`,
    };
  },
  pprintAction: function (params: ThinkingActionType): string {
    return `Think about: "${params.plan}"`;
  },
};
