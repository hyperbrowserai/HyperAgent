import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";

export const PageBackAction = z
  .object({})
  .describe("Navigate back to the previous page in the browser history");

export type PageBackActionType = z.infer<typeof PageBackAction>;

export const PageBackActionDefinition: AgentActionDefinition<
  typeof PageBackAction
> = {
  type: "pageBack" as const,
  shouldIgnoreActionForScan: true,
  actionParams: PageBackAction,
  run: async (ctx: ActionContext) => {
    await ctx.page.goBack();
    return { success: true, message: "Navigated back to the previous page" };
  },
  pprintAction: function (): string {
    return "Navigate back to previous page";
  },
};
