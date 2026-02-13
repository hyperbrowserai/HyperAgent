import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";
import {
  buildActionFailureMessage,
  getPageMethod,
  invalidateDomCacheSafely,
  normalizeActionText,
} from "./shared/action-runtime";

export const GoToUrlAction = z
  .object({
    url: z.string().describe("The URL you want to navigate to."),
  })
  .describe("Navigate to a specific URL in the browser");

export type GoToUrlActionType = z.infer<typeof GoToUrlAction>;

export const GoToURLActionDefinition: AgentActionDefinition = {
  type: "goToUrl" as const,
  actionParams: GoToUrlAction,
  run: async (ctx: ActionContext, action: GoToUrlActionType) => {
    const url = normalizeActionText(action?.url, "", 4_000);
    if (url.length === 0) {
      return {
        success: false,
        message: "Failed to navigate: URL must be a non-empty string.",
      };
    }

    const goto = getPageMethod(ctx, "goto");
    if (!goto) {
      return {
        success: false,
        message: "Failed to navigate: page.goto is unavailable.",
      };
    }

    try {
      await goto(url);
      invalidateDomCacheSafely(ctx);
      return { success: true, message: `Navigated to ${url}` };
    } catch (error) {
      return {
        success: false,
        message: buildActionFailureMessage("navigate", error),
      };
    }
  },
  pprintAction: function(params: GoToUrlActionType): string {
    return `Navigate to URL: ${params.url}`;
  },
};
