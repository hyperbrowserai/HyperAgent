import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";

export const PageBackAction = z
  .object({})
  .describe("Navigate back to the previous page in the browser history");

export type PageBackActionType = z.infer<typeof PageBackAction>;

export const PageBackActionDefinition: AgentActionDefinition = {
  type: "pageBack" as const,
  actionParams: PageBackAction,

  run: async (ctx: ActionContext) => {
    await ctx.page.goBack();
    return { success: true, message: "Navigated back to the previous page" };
  },

  generateCode: async (ctx: ActionContext) => {
    return `await ctx.page.goBack();`;
  },

  pprintAction: function (): string {
    return "Navigate back to previous page";
  },
};
