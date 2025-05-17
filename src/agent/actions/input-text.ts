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
    pprintAction: function (params: InputTextActionType): string {
      return `Input text "${params.text}" into element at index ${params.index}`;
    },
  };
