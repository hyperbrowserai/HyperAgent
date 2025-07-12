import { z } from "zod";
import { ActionContext, ActionOutput, AgentActionDefinition } from "@/types";

export const generateCompleteActionWithOutputDefinition = (
  outputSchema: z.AnyZodObject,
): AgentActionDefinition => {
  const actionParamsSchema = z
    .object({
      success: z
        .boolean()
        .describe("Whether the task was completed successfully."),
      outputSchema: outputSchema
        .nullable()
        .describe(
          "The output model to return the response in. Given the previous data, try your best to fit the final response into the given schema.",
        ),
    })
    .describe(
      "Complete the task. An output schema has been provided to you. Try your best to provide your response so that it fits the output schema provided.",
    );

  type CompeleteActionWithOutputSchema = z.infer<typeof actionParamsSchema>;

  return {
    type: "complete" as const,
    actionParams: actionParamsSchema,

    run: async (
      ctx: ActionContext,
      actionParams: CompeleteActionWithOutputSchema,
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

    generateCode: async (
      ctx: ActionContext,
      action: CompeleteActionWithOutputSchema,
      prefix: string,
    ) => {
      const varPrefix = `${prefix}_complete_with_output_schema`;
      if (action.success && action.outputSchema) {
        return `
        let ${varPrefix}_outputSchema = \`${JSON.stringify(action.outputSchema, null, 2)}\`;
        for (const variable of Object.values(ctx.variables)) {
          ${varPrefix}_outputSchema = ${varPrefix}_outputSchema.replaceAll(
            \`<<\${variable.key}>>\`,
            variable.value as string,
          );
        }

        console.log("The action generated an object\\n");
        console.log(\`\${${varPrefix}_outputSchema}\\n\`);
      `;
      } else {
        return `
        console.log("Could not complete task and/or could not extract response into output schema.");
        `;
      }
    },

    completeAction: async (
      params: CompeleteActionWithOutputSchema,
      variables?: Record<string, any>,
    ) => {
      let outputSchemaString = JSON.stringify(params.outputSchema, null, 2);
      for (const variable of Object.values(variables ?? {})) {
        outputSchemaString = outputSchemaString.replaceAll(
          `<<${variable.key}>>`,
          variable.value,
        );
      }
      return outputSchemaString;
    },
  };
};
