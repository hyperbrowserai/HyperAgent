import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";
import { getLocator, getLocatorString } from "./utils";

export const SelectOptionAction = z
  .object({
    index: z
      .number()
      .describe("The numeric index of the  element to select an option."),
    indexElementDescription: z.string().describe(`
      A descriptive text that uniquely identifies this element on the page. 
      This should help locate this element again.
      Examples: "Search button", "Submit form button", "Next page arrow", "Login link in header"
      This description will be used as a fallback to find the element if the index changes.`),
    text: z.string().describe("The text of the option to select."),
  })
  .describe("Select an option from a dropdown element");

export type SelectOptionActionType = z.infer<typeof SelectOptionAction>;

export const SelectOptionActionDefinition: AgentActionDefinition = {
  type: "selectOption" as const,
  actionParams: SelectOptionAction,

  run: async (ctx: ActionContext, action: SelectOptionActionType) => {
    let { index, text } = action;
    for (const variable of Object.values(ctx.variables)) {
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

  generateCode: async (
    ctx: ActionContext,
    action: SelectOptionActionType,
    prefix: string,
  ) => {
    const locatorString = getLocatorString(ctx, action.index) ?? "";
    const varPrefix = `${prefix}_selectOption`;

    return `
      let ${varPrefix}_text = ${JSON.stringify(action.text)};
      for (const variable of Object.values(ctx.variables)) {
        ${varPrefix}_text = ${varPrefix}_text.replaceAll(
        \`<<\${variable.key}>>\`,
          variable.value as string
        );
      }

      const ${varPrefix}_querySelector = ${JSON.stringify(locatorString)};
      const ${varPrefix}_fallbackDescription = "Find the element with the text " + ${JSON.stringify(action.indexElementDescription)};
      const ${varPrefix}_locator = await ctx.page.getLocator(${varPrefix}_querySelector, ${varPrefix}_fallbackDescription);

      await ${varPrefix}_locator.selectOption({ label: ${varPrefix}_text });
      console.log(\`Selected option "\${${varPrefix}_text}" from element\`);
    `;
  },

  pprintAction: function (params: SelectOptionActionType): string {
    return `Select option "${params.text}" from element at index ${params.index}`;
  },
};
