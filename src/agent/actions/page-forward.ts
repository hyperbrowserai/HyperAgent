import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";
import {
  buildActionFailureMessage,
  getPageMethod,
  invalidateDomCacheSafely,
} from "./shared/action-runtime";

export const PageForwardAction = z
  .object({})
  .describe("Navigate forward to the next page in the browser history");

export type PageForwardActionType = z.infer<typeof PageForwardAction>;

export const PageForwardActionDefinition: AgentActionDefinition = {
  type: "pageForward" as const,
  actionParams: PageForwardAction,
  run: async (ctx: ActionContext) => {
    const goForward = getPageMethod(ctx, "goForward");
    if (!goForward) {
      return {
        success: false,
        message: "Failed to navigate forward: page.goForward is unavailable.",
      };
    }
    try {
      const response = await goForward();
      invalidateDomCacheSafely(ctx);
      if (!response) {
        return {
          success: true,
          message: "No next page in browser history.",
        };
      }
      return { success: true, message: "Navigated forward to the next page" };
    } catch (error) {
      return {
        success: false,
        message: buildActionFailureMessage("navigate forward", error),
      };
    }
  },
  pprintAction: function(): string {
    return "Navigate forward to next page";
  },
};
