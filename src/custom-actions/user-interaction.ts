import { z } from "zod";
import { ActionOutput, AgentActionDefinition } from "@/types";

// Define separate schemas for each interaction type to ensure OpenAI strict mode compatibility
const BaseUserInteractionParams = z.object({
  message: z
    .string()
    .describe(
      "A message to provide to the user. Make it friendly and ask them for a suitable response. Keep it short and between 1-2 sentences if possible."
    ),
});

const TextInputParams = BaseUserInteractionParams.extend({
  kind: z.literal("text_input"),
  choices: z.array(z.string()).length(0).describe("Must be an empty array for text_input kind."),
});

const PasswordParams = BaseUserInteractionParams.extend({
  kind: z.literal("password"),
  choices: z.array(z.string()).length(0).describe("Must be an empty array for password kind."),
});

const ConfirmParams = BaseUserInteractionParams.extend({
  kind: z.literal("confirm"),
  choices: z.array(z.string()).length(0).describe("Must be an empty array for confirm kind."),
});

const SelectParams = BaseUserInteractionParams.extend({
  kind: z.literal("select"),
  choices: z
    .array(z.string())
    .min(1)
    .describe("Array of choices to present to the user. Required for select kind."),
});

// Use a discriminated union for OpenAI strict mode compatibility
export const UserInteractionActionParams = z
  .discriminatedUnion("kind", [
    TextInputParams,
    PasswordParams,
    ConfirmParams,
    SelectParams,
  ])
  .describe(
    `Action to request input from the user during task execution.
    Use this when you need to collect information from the user such as text input, password,
    selection from choices, or confirmation. The response will be returned to continue the workflow.`
  );

export type UserInteractionActionParamsType =
  typeof UserInteractionActionParams;

type userInputFn = (
  params: z.infer<UserInteractionActionParamsType>
) => Promise<ActionOutput>;

export const UserInteractionAction = (
  userInputFn: userInputFn
): AgentActionDefinition<UserInteractionActionParamsType> => {
  return {
    type: "UserInteractionActionParams",
    actionParams: UserInteractionActionParams,
    run: async (ctx, action): Promise<ActionOutput> =>
      await userInputFn(action),
  };
};
