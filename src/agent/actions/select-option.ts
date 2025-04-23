import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";
import { getLocator } from "./utils";

export const SelectOptionAction = z
  .object({
    index: z
      .number()
      .describe("The numeric index of the  element to select an option."),
    text: z.string().describe("The text of the option to select."),
  })
  .describe("Select an option from a dropdown element");

export type SelectOptionActionType = typeof SelectOptionAction;

export const SelectOptionActionDefinition: AgentActionDefinition<SelectOptionActionType> =
  {
    type: "selectOption" as const,
    actionParams: SelectOptionAction,
    run: async (ctx: ActionContext, action) => {
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
    pprintAction: function (params): string {
      return `Select option "${params.text}" from element at index ${params.index}`;
    },
    hasDomChanged(currentDomState, previousDomState, params) {
      const currentElementAtIndex = currentDomState.elements.get(params.index);
      const previousElementAtIndex = previousDomState.elements.get(
        params.index
      );

      // Retrun true if the dom has changed
      return currentElementAtIndex?.xpath !== previousElementAtIndex?.xpath;
    },
  };
