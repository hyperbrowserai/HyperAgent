import { z } from "zod";
import { ActionContext, ActionOutput, AgentActionDefinition } from "@/types";
import { AGENT_ELEMENT_ACTIONS } from "../shared/action-restrictions";
import { performAction } from "./shared/perform-action";

const methodSchema = z
  .enum(AGENT_ELEMENT_ACTIONS)
  .describe(
    "Method to execute (click, fill, type, press, selectOptionFromDropdown, check, uncheck, hover, scrollToElement, scrollToPercentage, nextChunk, prevChunk)."
  );

const ActElementAction = z
  .object({
    instruction: z
      .string()
      .describe("Short explanation of why this action is needed."),
    elementId: z
      .string()
      .min(1)
      .describe(
        'Encoded element identifier from the DOM listing (format "frameIndex-backendNodeId", e.g., "0-5125").'
      ),
    method: methodSchema.describe(
      "CDP/Playwright method to invoke (click, fill, type, press, selectOptionFromDropdown, check, uncheck, hover, scrollToElement, scrollToPercentage, nextChunk, prevChunk)."
    ),
    arguments: z
      .array(z.string())
      .describe(
        "Arguments for the method (e.g., text to fill, key to press, scroll target). Use an empty array when no arguments are required."
      ),
    confidence: z
      .number()
      .describe(
        "LLM-estimated confidence (0-1). Used for debugging/telemetry; execution does not depend on it."
      ),
  })
  .describe(
    "Perform a single action on an element by referencing an encoded ID from the DOM listing."
  );

type ActElementActionType = z.infer<typeof ActElementAction>;

export const ActElementActionDefinition: AgentActionDefinition = {
  type: "actElement" as const,
  actionParams: ActElementAction,
  run: async function (
    ctx: ActionContext,
    action: ActElementActionType
  ): Promise<ActionOutput> {
    return performAction(ctx, action);
  },
  pprintAction: function (params: ActElementActionType): string {
    return `Act: ${params.instruction}`;
  },
};
