import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";
import { getLocator } from "./utils";

export const SelectOptionAction = z
  .object({
    elementId: z.union([z.number(), z.string()]).describe("The element ID (numeric index in visual mode or encoded ID like '0-1234' in a11y mode)"),
    text: z.string().describe("The text of the option to select."),
  })
  .describe("Select an option from a dropdown element");

export type SelectOptionActionType = z.infer<typeof SelectOptionAction>;

export const SelectOptionActionDefinition: AgentActionDefinition = {
  type: "selectOption" as const,
  actionParams: SelectOptionAction,
  run: async (ctx: ActionContext, action: SelectOptionActionType) => {
    const id = action.elementId;
    const { text } = action;
    const locator = getLocator(ctx, id);
    if (!locator) {
      return { success: false, message: "Element not found" };
    }
    await locator.selectOption({ label: text });
    return {
      success: true,
      message: `Selected option "${text}" from element with ID ${id}`,
    };
  },
  pprintAction: function (params: SelectOptionActionType): string {
    return `Select option "${params.text}" from element at ID ${params.elementId}`;
  },
};
