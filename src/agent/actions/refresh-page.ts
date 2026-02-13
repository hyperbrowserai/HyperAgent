import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";
import {
  buildActionFailureMessage,
  getPageMethod,
  invalidateDomCacheSafely,
} from "./shared/action-runtime";

export const RefreshPageAction = z
  .object({})
  .describe(
    "Refresh a webpage. Refreshing a webpage is usually a good way if you need to reset the state on a page. Take care since every thing you did on that page will be reset."
  );

export type RefreshPageActionType = z.infer<typeof RefreshPageAction>;

export const RefreshPageActionDefinition: AgentActionDefinition = {
  type: "refreshPage" as const,
  actionParams: RefreshPageAction,
  run: async (ctx: ActionContext) => {
    const reload = getPageMethod(ctx, "reload");
    if (!reload) {
      return {
        success: false,
        message: "Failed to refresh page: page.reload is unavailable.",
      };
    }
    try {
      await reload();
      invalidateDomCacheSafely(ctx);
      return { success: true, message: "Successfully refreshed the page." };
    } catch (error) {
      return {
        success: false,
        message: buildActionFailureMessage("refresh page", error),
      };
    }
  },
  pprintAction: function(): string {
    return "Refresh current page";
  },
};
