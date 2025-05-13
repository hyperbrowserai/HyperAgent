import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";

export const GoToUrlAction = z
  .object({
    url: z.string().describe("The URL you want to navigate to."),
  })
  .describe("Navigate to a specific URL in the browser");

export type GoToUrlActionType = z.infer<typeof GoToUrlAction>;

export const GoToURLActionDefinition: AgentActionDefinition = {
  type: "goToUrl" as const,
  shouldIgnoreActionForScan: true,
  actionParams: GoToUrlAction,
  run: async (ctx: ActionContext, action: GoToUrlActionType) => {
    const { url } = action;
    await ctx.page.goto(url);
    return { success: true, message: `Navigated to ${url}` };
  },
  pprintAction: function (params: GoToUrlActionType): string {
    return `Navigate to URL: ${params.url}`;
  },
};
