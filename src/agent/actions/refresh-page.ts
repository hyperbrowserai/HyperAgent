import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";

export const RefreshPageAction = z
  .object({})
  .describe(
    "Refresh a webpage. Refreshing a webpage is usually a good way if you need to reset the state on a page. Take care since every thing you did on that page will be reset.",
  );

export type RefreshPageActionType = z.infer<typeof RefreshPageAction>;

export const RefreshPageActionDefinition: AgentActionDefinition = {
  type: "refreshPage" as const,
  actionParams: RefreshPageAction,

  run: async (ctx: ActionContext) => {
    await ctx.page.reload();
    return { success: true, message: "Succesfully refreshed a page." };
  },

  generateCode: async (ctx: ActionContext) => {
    return `await ctx.page.reload();`;
  },

  pprintAction: function (): string {
    return "Refresh current page";
  },
};
