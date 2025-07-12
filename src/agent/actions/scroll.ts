import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";

export const ScrollAction = z
  .object({
    direction: z
      .enum(["up", "down", "left", "right"])
      .describe("The direction to scroll."),
  })
  .describe("Scroll in a specific direction in the browser");

export type ScrollActionType = z.infer<typeof ScrollAction>;

export const ScrollActionDefinition: AgentActionDefinition = {
  type: "scroll" as const,
  actionParams: ScrollAction,

  run: async (ctx: ActionContext, action: ScrollActionType) => {
    const { direction } = action;
    switch (direction) {
      case "up":
        await ctx.page.evaluate(() => window.scrollBy(0, -window.innerHeight));
        break;
      case "down":
        await ctx.page.evaluate(() => window.scrollBy(0, window.innerHeight));
        break;
      case "left":
        await ctx.page.evaluate(() => window.scrollBy(-window.innerWidth, 0));
        break;
      case "right":
        await ctx.page.evaluate(() => window.scrollBy(window.innerWidth, 0));
        break;
    }
    return { success: true, message: `Scrolled ${direction}` };
  },

  generateCode: async (ctx: ActionContext, action: ScrollActionType) => {
    const { direction } = action;

    return `
      await ctx.page.evaluate(() => {
        const scrollByUpDown = ${direction === "up" ? "-window.innerHeight" : direction === "down" ? "window.innerHeight" : "0"};
        const scrollByLeftRight = ${direction === "left" ? "-window.innerWidth" : direction === "right" ? "window.innerWidth" : "0"};
        window.scrollBy(scrollByLeftRight, scrollByUpDown);
      });
    `;
  },

  pprintAction: function (params: ScrollActionType): string {
    return `Scroll ${params.direction}`;
  },
};
