import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";
import {
  buildActionFailureMessage,
  getPageMethod,
  invalidateDomCacheSafely,
  normalizeActionText,
} from "./shared/action-runtime";

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
    const direction = normalizeActionText(action?.direction, "down", 16).toLowerCase();
    const evaluate = getPageMethod(ctx, "evaluate");
    if (!evaluate) {
      return {
        success: false,
        message: "Failed to scroll: page.evaluate is unavailable.",
      };
    }

    try {
      switch (direction) {
        case "up":
          await evaluate(() => window.scrollBy(0, -window.innerHeight));
          break;
        case "down":
          await evaluate(() => window.scrollBy(0, window.innerHeight));
          break;
        case "left":
          await evaluate(() => window.scrollBy(-window.innerWidth, 0));
          break;
        case "right":
          await evaluate(() => window.scrollBy(window.innerWidth, 0));
          break;
        default:
          return {
            success: false,
            message: `Failed to scroll: unsupported direction "${direction}".`,
          };
      }
      invalidateDomCacheSafely(ctx);
      return { success: true, message: `Scrolled ${direction}` };
    } catch (error) {
      return {
        success: false,
        message: buildActionFailureMessage("scroll page", error),
      };
    }
  },
  pprintAction: function(params: ScrollActionType): string {
    return `Scroll ${params.direction}`;
  },
};
