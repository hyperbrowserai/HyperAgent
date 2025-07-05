import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";
import { getLocator, getLocatorString } from "./utils";

export const SelectOptionAction = z
  .object({
    index: z
      .number()
      .describe("The numeric index of the  element to select an option."),
    text: z.string().describe("The text of the option to select."),
    variableName: z.string()
      .regex(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/, "Must be a valid TypeScript identifier")
      .describe("The variable name used to identify a variable. Must be a valid TypeScript identifier and not previously used."),
  })
  .describe("Select an option from a dropdown element");

export type SelectOptionActionType = z.infer<typeof SelectOptionAction>;

export const SelectOptionActionDefinition: AgentActionDefinition = {
  type: "selectOption" as const,
  actionParams: SelectOptionAction,

  run: async (ctx: ActionContext, action: SelectOptionActionType) => {
    const { index, text } = action;
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
  ) => {
    const locatorString = getLocatorString(ctx, action.index) ?? "";
    const variableName = action.variableName;

    return `
      const querySelector${variableName} = '${locatorString}';
      const fallbackDescription${variableName} = "Find the element with the text '${variableName}'";
      const locator${variableName} = ctx.page.getLocator(querySelector${variableName}, fallbackDescription${description});

      await locator${variableName}.selectOption({ label: ${JSON.stringify(action.text)} });
    `;
  },

  pprintAction: function (params: SelectOptionActionType): string {
    return `Select option "${params.text}" from element at index ${params.index}`;
  },
};
