import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";
import { getLocator } from "./utils";

export const SelectOptionAction = z
  .object({
    index: z
      .number()
      .describe("The numeric index of the  element to select an option."),
    text: z.string().describe("The text of the option to select."),
    description: z.string()
      .regex(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/, "Must be a valid TypeScript identifier")
      .describe("The description of the option to select."),
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
    const locator = getLocator(ctx, action.index);
    const description = action.description;

    return `
      const querySelector${description} = ${locator}.toString();
      const fallbackDescription${description} = "Find the element with the text '${description}'";
      const locator${description} = ctx.page.getLocator(querySelector${description}, fallbackDescription${description});

      await locator${description}.selectOption({ label: ${JSON.stringify(action.text)} });
    `;
  },

  pprintAction: function (params: SelectOptionActionType): string {
    return `Select option "${params.text}" from element at index ${params.index}`;
  },
};
