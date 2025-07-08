import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";
import { getLocator, getLocatorString } from "./utils";

export const InputTextAction = z
  .object({
    index: z
      .number()
      .describe("The numeric index of the element to input text."),
    variableName: z.string()
      .regex(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/, "Must be a valid TypeScript identifier")
      .describe("The variable name used to identify a variable. Must be a valid TypeScript identifier and not previously used."),
    text: z.string().describe(
      `The text to input. Use <<variableKey>> to reference extracted variables 
      (e.g., 'Capital of <<top_country_1>>')`),
  })
  .describe("Input text into a input interactive element");

export type InputTextActionType = z.infer<typeof InputTextAction>;

export const InputTextActionDefinition: AgentActionDefinition = {
    type: "inputText" as const,
    actionParams: InputTextAction,

    run: async (ctx: ActionContext, action: InputTextActionType) => {
      let { index, text } = action;
      const locator = getLocator(ctx, index);
      for (const variable of ctx.variables) {
        text = text.replace(`<<${variable.key}>>`, variable.value);
      }
      if (!locator) {
        return { success: false, message: "Element not found" };
      }
      await locator.fill(text, { timeout: 5_000 });
      return {
        success: true,
        message: `Inputted text "${text}" into element with index ${index}`,
      };
    },

    generateCode: async (
      ctx: ActionContext,
      action: InputTextActionType,
    ) => {
      const variableName = action.variableName;
      const locatorString = getLocatorString(ctx, action.index) ?? "";

      return `
        let text${variableName} = ${JSON.stringify(action.text)};
        for (const variable of Object.values(ctx.variables)) {
          text${variableName} = text${variableName}.replace(\`<<\${variable.key}>>\`, variable.value as string);
        }

        const querySelector${variableName} = '${locatorString}';
        const fallbackDescription${variableName} = "Find the element with the text '${variableName}'";
        const locator${variableName} = await ctx.page.getLocator(querySelector${variableName}, fallbackDescription${variableName});

        await locator${variableName}.fill(text${variableName}, { timeout: 5_000 });
      `;
    },

    pprintAction: function (params: InputTextActionType): string {
      return `Input text "${params.text}" into element at index ${params.index}`;
    },
  };
