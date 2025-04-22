import { z } from "zod";
import { Locator } from "playwright";
import { ActionContext, ActionOutput, AgentActionDefinition } from "@/types";
import { sleep } from "@/utils";
import { getLocator } from "./utils";

const ClickElementAction = z
  .object({
    index: z.number().describe("The numeric index of the element to click."),
  })
  .describe("Click on an element identified by its index");

type ClickElementActionType = z.infer<typeof ClickElementAction>;

const MAX_STABLE_CHECKS = 2;
const CLICK_CHECK_TIMEOUT_PERIOD = 2_500;

export const ClickElementActionDefinition: AgentActionDefinition = {
  type: "clickElement" as const,
  actionParams: ClickElementAction,
  run: async function (
    ctx: ActionContext,
    action: ClickElementActionType
  ): Promise<ActionOutput> {
    const { index } = action;
    const locator = getLocator(ctx, index);
    if (!locator) {
      return { success: false, message: "Element not found" };
    }

    const exists = (await locator.count()) > 0;
    if (!exists) {
      return { success: false, message: "Element not found on page" };
    }

    await locator.scrollIntoViewIfNeeded({
      timeout: CLICK_CHECK_TIMEOUT_PERIOD,
    });

    await Promise.all([
      locator.waitFor({
        state: "visible",
        timeout: CLICK_CHECK_TIMEOUT_PERIOD,
      }),
      waitForElementToBeEnabled(locator, CLICK_CHECK_TIMEOUT_PERIOD),
      waitForElementToBeStable(locator, CLICK_CHECK_TIMEOUT_PERIOD),
    ]);

    await locator.click({ force: true });
    return { success: true, message: `Clicked element with index ${index}` };
  },
  pprintAction: function (params: ClickElementActionType): string {
    return `Click element at index ${params.index}`;
  },
};

/**
 * Waits for an element to become enabled with a timeout
 * @param locator The Playwright locator to check
 * @param timeout Maximum time to wait in milliseconds
 * @returns Promise that resolves when element is enabled or rejects on timeout
 */
async function waitForElementToBeEnabled(
  locator: Locator,
  timeout: number = 5000
): Promise<void> {
  return Promise.race([
    (async () => {
      while (true) {
        if (await locator.isEnabled()) {
          return;
        }
        await sleep(100);
      }
    })(),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("Timeout waiting for element to be enabled")),
        timeout
      );
    }),
  ]);
}

/**
 * Waits for an element to become stable (not moving) with a timeout
 * @param locator The Playwright locator to check
 * @param timeout Maximum time to wait in milliseconds
 * @returns Promise that resolves when element is stable or rejects on timeout
 */
async function waitForElementToBeStable(
  locator: Locator,
  timeout: number = 5000
): Promise<void> {
  return Promise.race([
    (async () => {
      let previousRect: {
        x: number;
        y: number;
        width: number;
        height: number;
      } | null = null;
      let stableCount = 0;

      while (true) {
        const currentRect = await locator.boundingBox();
        if (!currentRect) {
          await sleep(100);
          continue;
        }

        if (
          previousRect &&
          previousRect.x === currentRect.x &&
          previousRect.y === currentRect.y &&
          currentRect.width === (previousRect.width ?? 0) &&
          currentRect.height === (previousRect.height ?? 0)
        ) {
          stableCount++;
          if (stableCount >= MAX_STABLE_CHECKS) {
            // Element stable for {{ MAX_STABLE_CHECKS }} consecutive checks
            return;
          }
        } else {
          stableCount = 0;
        }

        previousRect = currentRect;
        await sleep(100);
      }
    })(),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("Timeout waiting for element to be stable")),
        timeout
      );
    }),
  ]);
}
