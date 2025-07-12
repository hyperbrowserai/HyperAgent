import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";
import { getLocator, getLocatorString } from "./utils";

export const InputTextAction = z
  .object({
    index: z
      .number()
      .describe("The numeric index of the element to input text."),
    indexElementDescription: z.string().describe(`
      A descriptive text that uniquely identifies this element on the page. 
      This should help locate this element again.
      Examples: "Search button", "Submit form button", "Next page arrow", "Login link in header"
      This description will be used as a fallback to find the element if the index changes.`),
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
    for (const variable of Object.values(ctx.variables)) {
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

  generateCode: async (
    ctx: ActionContext,
    action: InputTextActionType,
    prefix: string,
  ) => {
    const locatorString = getLocatorString(ctx, action.index) ?? "";

    const varPrefix = `${prefix}_inputText`;

    return `
        let ${varPrefix}_text = ${JSON.stringify(action.text)};
        for (const variable of Object.values(ctx.variables)) {
          ${varPrefix}_text = ${varPrefix}_text.replaceAll(
            \`<<\${variable.key}>>\`,
            variable.value as string,
          );
        }

            const ${varPrefix}_querySelector = ${JSON.stringify(locatorString)};
    const ${varPrefix}_fallbackDescription = "Find the element with the text " + ${JSON.stringify(action.indexElementDescription)};
        const ${varPrefix}_locator = await ctx.page.getLocator(${varPrefix}_querySelector, ${varPrefix}_fallbackDescription);

        await ${varPrefix}_locator.fill(${varPrefix}_text, { timeout: 5_000 });
        console.log(\`Inputted text "\${${varPrefix}_text}" into element\`);
      `;
  },

  pprintAction: function (params: InputTextActionType): string {
    return `Input text "${params.text}" into element at index ${params.index}`;
  },
};
