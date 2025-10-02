import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";
import { getLocator } from "./utils";

const PLACEHOLDER_PATTERN = /(\\*)<<([^<>]+)>>/g;

const substituteVariables = (
  rawText: string,
  variables: ActionContext["variables"],
): string => {
  if (!variables.length) {
    return rawText;
  }

  const variableMap = new Map(
    variables.map((variable) => [variable.key, variable.value] as const),
  );

  return rawText.replace(PLACEHOLDER_PATTERN, (match, slashes, key) => {
    const backslashes = typeof slashes === "string" ? slashes : "";
    const placeholder = `<<${key}>>`;
    const isEscaped = backslashes.length % 2 === 1;

    if (isEscaped) {
      return backslashes.slice(1) + placeholder;
    }

    const value = variableMap.get(key);

    if (value === undefined) {
      return match;
    }

    const literalPrefix = backslashes.slice(0, backslashes.length / 2);
    return `${literalPrefix}${value}`;
  });
};

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
      text = substituteVariables(text, ctx.variables);
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
