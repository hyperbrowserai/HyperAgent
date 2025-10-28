import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";
import { getLocator } from "./utils";

export const InputTextAction = z
  .object({
    elementId: z.union([z.number(), z.string()]).describe("The element ID (numeric index in visual mode or encoded ID like '0-1234' in a11y mode)"),
    text: z.string().describe("The text to input."),
  })
  .describe("Input text into a input interactive element");

export type InputTextActionType = z.infer<typeof InputTextAction>;

export const InputTextActionDefinition: AgentActionDefinition = {
    type: "inputText" as const,
    actionParams: InputTextAction,
    run: async (ctx: ActionContext, action: InputTextActionType) => {
      const id = action.elementId;
      let { text } = action;
      const locator = getLocator(ctx, id);
      for (const variable of ctx.variables) {
        text = text.replace(`<<${variable.key}>>`, variable.value);
      }
      if (!locator) {
        return { success: false, message: "Element not found" };
      }
      await locator.fill(text, { timeout: 5_000 });
      return {
        success: true,
        message: `Inputted text "${text}" into element with ID ${id}`,
      };
    },
    pprintAction: function (params: InputTextActionType): string {
      return `Input text "${params.text}" into element at ID ${params.elementId}`;
    },
  };
