import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";
import { getLocator, getLocatorString } from "./utils";

export const InputTextAction = z
  .object({
    index: z
      .number()
      .describe("The numeric index of the element to input text."),
    indexDescription: z.string().describe(`
      A descriptive text that uniquely identifies this element on the page. 
      This should help locate this element again.
      Examples: "Search button", "Submit form button", "Next page arrow", "Login link in header"
      This description will be used as a fallback to find the element if the index changes.`),
    variableName: z
      .string()
      .regex(
        /^[a-zA-Z_$][a-zA-Z0-9_$]*$/,
        "Must be a valid TypeScript identifier",
      )
      .describe(
        "The variable name used to identify a variable. Must be a valid TypeScript identifier and not previously used.",
      ),
    text: z.string().describe(
      `The text to input. Use <<variableKey>> to reference extracted variables 
      (e.g., 'Capital of <<top_country_1>>')`,
    ),
  })
  .describe("Input text into a input interactive element");

export type InputTextActionType = z.infer<typeof InputTextAction>;

export const InputTextActionDefinition: AgentActionDefinition = {
  type: "inputText" as const,
  actionParams: InputTextAction,

  run: async (ctx: ActionContext, action: InputTextActionType) => {
    let { index, text } = action;
    for (const variable of ctx.variables) {
      text = text.replaceAll(`<<${variable.key}>>`, variable.value);
    }

    const locator = getLocator(ctx, index);
    if (!locator) {
      return { success: false, message: "Element not found" };
    }
    await locator.fill(text, { timeout: 5_000 });

    return {
      success: true,
      message: `Inputted text "${text}" into element with index ${index}`,
    };
  },

  generateCode: async (ctx: ActionContext, action: InputTextActionType) => {
    const variableName = action.variableName;
    const locatorString = getLocatorString(ctx, action.index) ?? "";

    return `
        let text_${variableName} = ${JSON.stringify(action.text)};
        for (const variable of Object.values(ctx.variables)) {
          text_${variableName} = text_${variableName}.replaceAll(
            \`<<\${variable.key}>>\`,
            variable.value as string
          );
        }

        const querySelector_${variableName} = '${locatorString}';
        const fallbackDescription_${variableName} = "Find the element with the text '${action.indexDescription}'";
        const locator_${variableName} = await ctx.page.getLocator(querySelector_${variableName}, fallbackDescription_${variableName});

        await locator_${variableName}.fill(text_${variableName}, { timeout: 5_000 });
        console.log(\`Inputted text "\${text_${variableName}}" into element\`);
      `;
  },

  pprintAction: function (params: InputTextActionType): string {
    return `Input text "${params.text}" into element at index ${params.index}`;
  },
};
