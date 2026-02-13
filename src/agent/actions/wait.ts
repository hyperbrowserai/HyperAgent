import { z } from "zod";
import { ActionContext, ActionOutput, AgentActionDefinition } from "@/types";
import { waitForSettledDOM } from "@/utils/waitForSettledDOM";
import {
  buildActionFailureMessage,
  invalidateDomCacheSafely,
  normalizeActionText,
} from "./shared/action-runtime";

const WaitAction = z
  .object({
    reason: z
      .string()
      .describe(
        "Explain why you cannot confidently take an action right now (e.g., 'Page is still loading', 'Expected element not visible yet', 'Waiting for dynamic content to appear', 'Page may still be transitioning')"
      ),
  })
  .describe("Use this action when you are not confident enough to take a meaningful action. The page may still be loading, elements may not be visible yet, or the page state may be unclear. The system will wait for the DOM to settle and give you a fresh view.");

type WaitActionType = z.infer<typeof WaitAction>;
const WAIT_POST_SETTLE_DELAY_MS = 1_000;

export const WaitActionDefinition: AgentActionDefinition = {
  type: "wait" as const,
  actionParams: WaitAction,
  run: async function (
    ctx: ActionContext,
    action: WaitActionType
  ): Promise<ActionOutput> {
    const reason = normalizeActionText(action?.reason, "waiting for page stability");
    try {
      // Wait for DOM to settle (page to finish loading/transitioning)
      await waitForSettledDOM(ctx.page);

      // Additional brief wait to allow any animations/transitions to complete
      await new Promise((resolve) => setTimeout(resolve, WAIT_POST_SETTLE_DELAY_MS));
      invalidateDomCacheSafely(ctx);

      return {
        success: true,
        message: `Waiting for page to stabilize: ${reason}`,
      };
    } catch (error) {
      return {
        success: false,
        message: buildActionFailureMessage("wait for page stabilization", error),
      };
    }
  },
  pprintAction: function (params: WaitActionType): string {
    return `Wait: ${params.reason}`;
  },
};
