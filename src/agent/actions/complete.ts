import { z } from "zod";
import { ActionContext, ActionOutput, AgentActionDefinition } from "@/types";

export const CompleteAction = z
  .object({
    success: z
      .boolean()
      .describe("Whether the task was completed successfully."),
    text: z
      .string()
      .nullable()
      .describe(
        "The text to complete the task with, make this answer the ultimate goal of the task. Be sure to include all the information requested in the task in explicit detail.",
      ),
  })
  .describe("Complete the task, this must be the final action in the sequence");

export type CompleteActionType = z.infer<typeof CompleteAction>;

export const CompleteActionDefinition: AgentActionDefinition = {
  type: "complete" as const,
  actionParams: CompleteAction,

  run: async (): Promise<ActionOutput> => {
    return { success: true, message: "Task Complete" };
  },

  generateCode: async (
    _: ActionContext,
    action: CompleteActionType,
    prefix: string,
  ) => {
    const varPrefix = `${prefix}_complete`;

    return `
      let ${varPrefix}_text = ${JSON.stringify(action.text)};
      for (const variable of Object.values(ctx.variables)) {
        ${varPrefix}_text = ${varPrefix}_text.replaceAll(
          \`<<\${variable.key}>>\`,
          variable.value as string,
        );
      }
      console.log(\`Task complete: \${${varPrefix}_text}\`);
    `;
  },

  completeAction: async (
    params: CompleteActionType,
    variables?: Record<string, any>,
  ) => {
    let text = params.text ?? "No response text found";
    if (variables) {
      for (const variable of Object.values(variables)) {
        text = text.replaceAll(`<<${variable.key}>>`, variable.value);
      }
    }
    return text;
  },

  pprintAction: function (params: CompleteActionType): string {
    return `Complete task with ${params.success ? "success" : "failure"}`;
  },
};
