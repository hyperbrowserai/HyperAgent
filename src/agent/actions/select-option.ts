import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";
import { getLocator, getLocatorString } from "./utils";

export const SelectOptionAction = z
  .object({
    index: z
      .number()
      .describe("The numeric index of the  element to select an option."),
    indexDescription: z.string().describe(`
      A descriptive text that uniquely identifies this element on the page. 
      This should help locate this element again.
      Examples: "Search button", "Submit form button", "Next page arrow", "Login link in header"
      This description will be used as a fallback to find the element if the index changes.`),
    text: z.string().describe("The text of the option to select."),
    variableName: z
      .string()
      .regex(
        /^[a-zA-Z_$][a-zA-Z0-9_$]*$/,
        "Must be a valid TypeScript identifier",
      )
      .describe(
        "The variable name used to identify a variable. Must be a valid TypeScript identifier and not previously used.",
      ),
  })
  .describe("Select an option from a dropdown element");

export type SelectOptionActionType = z.infer<typeof SelectOptionAction>;

export const SelectOptionActionDefinition: AgentActionDefinition = {
  type: "selectOption" as const,
  actionParams: SelectOptionAction,

  run: async (ctx: ActionContext, action: SelectOptionActionType) => {
    let { index, text } = action;
    for (const variable of ctx.variables) {
      text = text.replaceAll(`<<${variable.key}>>`, variable.value);
    }

    const locator = getLocator(ctx, index);
    if (!locator) {
      return { success: false, message: "Element not found" };
    }

    await locator.selectOption({ label: text });
    return {
      success: true,
      message: `Selected option "${text}" from element with index ${index}`,
    };
  },

  generateCode: async (ctx: ActionContext, action: SelectOptionActionType) => {
    const locatorString = getLocatorString(ctx, action.index) ?? "";
    const variableName = action.variableName;

    return `
      let text_${variableName} = ${JSON.stringify(action.text)};
      for (const variable of Object.values(ctx.variables)) {
        text_${variableName} = text_${variableName}replaceAll(
        \`<<\${variable.key}>>\`,
          variable.value as string
        );
      }

      const querySelector_${variableName} = '${locatorString}';
      const fallbackDescription_${variableName} = "Find the element with the text '${action.indexDescription}'";
      const locator_${variableName} = await ctx.page.getLocator(querySelector_${variableName}, fallbackDescription_${variableName});

      await locator_${variableName}.selectOption({ label: text_${variableName} });
      console.log(\`Selected option "\${text_${variableName}}" from element\`);
    `;
  },

  pprintAction: function (params: SelectOptionActionType): string {
    return `Select option "${params.text}" from element at index ${params.index}`;
  },
};
