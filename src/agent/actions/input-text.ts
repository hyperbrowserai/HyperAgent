import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";
import { getLocator } from "./utils";

export const InputTextAction = z
  .object({
    index: z
      .number()
      .describe("The numeric index of the element to input text."),
    text: z.string().describe("The text to input."),
  })
  .describe("Input text into a input interactive element");

export type InputTextActionType = typeof InputTextAction;

export const InputTextActionDefinition: AgentActionDefinition<InputTextActionType> =
  {
    type: "inputText" as const,
    actionParams: InputTextAction,
    run: async (ctx: ActionContext, action) => {
      const { index, text } = action;
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
    pprintAction: function (params: z.infer<InputTextActionType>): string {
      return `Input text "${params.text}" into element at index ${params.index}`;
    },
    hasDomChanged(
      currentDomState,
      previousDomState,
      params
    ) {
      const currentElementAtIndex = currentDomState.elements.get(params.index);
      const previousElementAtIndex = previousDomState.elements.get(
        params.index
      );

      // Retrun true if the dom has changed
      return currentElementAtIndex?.xpath !== previousElementAtIndex?.xpath;
    },
  };
