import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";

export const ThinkingAction = z
  .object({
    thought: z
      .string()
      .describe(
        "Think about what your current course of action, and your future steps, and what difficulties you might encounter, and how you'd tackle them."
      ),
  })
  .describe(
    `Think about a course of action. Think what your current task is, what your next should be, and how you would possibly do that. This step is especially useful if performing a complex task, and/or working on a visually complex page (think nodes > 300).`
  );

export type ThinkingActionType = z.infer<typeof ThinkingAction>;

export const ThinkingActionDefinition: AgentActionDefinition = {
  type: "thinkAction" as const,
  actionParams: ThinkingAction,
  run: async (ctx: ActionContext, action: ThinkingActionType) => {
    const { thought } = action;
    return {
      success: true,
      message: `A simple thought process about your next steps. You thought about: ${thought}`,
    };
  },
  pprintAction: function(params: ThinkingActionType): string {
    return `Think about: "${params.thought}"`;
  },
};
