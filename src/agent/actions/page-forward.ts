import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";

export const PageForwardAction = z
  .object({})
  .describe("Navigate forward to the next page in the browser history");

export type PageForwardActionType = z.infer<typeof PageForwardAction>;

export const PageForwardActionDefinition: AgentActionDefinition = {
  type: "pageForward" as const,
  actionParams: PageForwardAction,

  run: async (ctx: ActionContext) => {
    await ctx.page.goForward();
    return { success: true, message: "Navigated forward to the next page" };
  },

  generateCode: async (ctx: ActionContext) => {
    return `await ctx.page.goForward();`;
  },

  pprintAction: function (): string {
    return "Navigate forward to next page";
  },
};
