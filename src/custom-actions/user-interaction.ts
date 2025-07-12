import { z } from "zod";
import { ActionOutput, AgentActionDefinition } from "@/types";

export const UserInteractionActionParams = z.object({
  message: z
    .string()
    .describe(
      "A message to provide to the user. Make it friendly and ask them for a suitable response. Keep it short and between 1-2 sentences if possible.",
    ),
  kind: z
    .enum(["password", "text_input", "select", "confirm"])
    .describe(
      "The kind of response that is expected from the user. If you can't find a suitable option, then respond with confirm.",
    ),
  choices: z
    .array(z.string())
    .optional()
    .describe(
      "If you select choices as the kind option, then what options should be offered to the user.",
    ),
}).describe(`Action to request input from the user during task execution.
    Use this when you need to collect information from the user such as text input, password, 
    selection from choices, or confirmation. The response will be returned to continue the workflow.`);

export type UserInteractionActionParamsType =
  typeof UserInteractionActionParams;

type userInputFn = (
  params: z.infer<UserInteractionActionParamsType>,
) => Promise<ActionOutput>;

export const UserInteractionAction = (
  userInputFn: userInputFn,
): AgentActionDefinition<UserInteractionActionParamsType> => {
  return {
    type: "UserInteractionActionParams",
    actionParams: UserInteractionActionParams,
    run: async (ctx, action): Promise<ActionOutput> =>
      await userInputFn(action),
  };
};
