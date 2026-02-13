import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";
import {
  buildActionFailureMessage,
  getPageMethod,
  invalidateDomCacheSafely,
} from "./shared/action-runtime";

export const PageBackAction = z
  .object({})
  .describe("Navigate back to the previous page in the browser history");

export type PageBackActionType = z.infer<typeof PageBackAction>;

export const PageBackActionDefinition: AgentActionDefinition = {
  type: "pageBack" as const,
  actionParams: PageBackAction,
  run: async (ctx: ActionContext) => {
    const goBack = getPageMethod(ctx, "goBack");
    if (!goBack) {
      return {
        success: false,
        message: "Failed to navigate back: page.goBack is unavailable.",
      };
    }
    try {
      const response = await goBack();
      invalidateDomCacheSafely(ctx);
      if (!response) {
        return {
          success: true,
          message: "No previous page in browser history.",
        };
      }
      return { success: true, message: "Navigated back to the previous page" };
    } catch (error) {
      return {
        success: false,
        message: buildActionFailureMessage("navigate back", error),
      };
    }
  },
  pprintAction: function(): string {
    return "Navigate back to previous page";
  },
};
