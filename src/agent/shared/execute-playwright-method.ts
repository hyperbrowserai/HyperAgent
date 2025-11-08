/**
 * Shared utility for executing Playwright methods on locators
 * Extracted from HyperAgent.executePlaywrightMethod for reusability
 */

import type { Page } from "playwright-core";

/**
 * Execute a Playwright method on a locator
 * Handles all supported action types (click, fill, scroll, etc.)
 *
 * @param method The Playwright method to execute
 * @param args Arguments for the method
 * @param locator The Playwright locator to execute on
 * @param options Configuration options
 * @throws Error if method is unknown
 */
export async function executePlaywrightMethod(
  method: string,
  args: unknown[],
  locator: ReturnType<Page["locator"]>,
  options: { clickTimeout?: number; debug?: boolean } = {}
): Promise<void> {
  const { clickTimeout = 3500, debug = false } = options;

  switch (method) {
    case "click":
      try {
        await locator.click({ timeout: clickTimeout });
      } catch (e) {
        // Fallback to JavaScript click if Playwright click fails (e.g., element interception)
        const errorMsg = e instanceof Error ? e.message : String(e);
        if (debug) {
          console.log(
            `[executePlaywrightMethod] Playwright click failed, falling back to JS click: ${errorMsg}`
          );
        }
        try {
          await locator.evaluate(
            (el) => (el as HTMLElement).click(),
            undefined,
            { timeout: clickTimeout }
          );
        } catch (jsClickError) {
          // Re-throw with context from both attempts
          const jsErrorMsg =
            jsClickError instanceof Error
              ? jsClickError.message
              : String(jsClickError);
          throw new Error(
            `Failed to click element. Playwright error: ${errorMsg}. JS click error: ${jsErrorMsg}`
          );
        }
      }
      break;
    case "type":
    case "fill":
      await locator.fill((args[0] as string) || "");
      break;
    case "selectOptionFromDropdown":
      await locator.selectOption((args[0] as string) || "");
      break;
    case "hover":
      await locator.hover();
      break;
    case "press":
      await locator.press((args[0] as string) || "Enter");
      break;
    case "check":
      await locator.check();
      break;
    case "uncheck":
      await locator.uncheck();
      break;
    case "scrollTo":
      {
        // Scroll to percentage of element or viewport height
        const scrollArg = (args[0] || "50%").toString();
        await locator.evaluate(
          (element, { yArg }) => {
            function parsePercent(val: string): number {
              const cleaned = val.trim().replace("%", "");
              const num = parseFloat(cleaned);
              return Number.isNaN(num) ? 0 : Math.max(0, Math.min(num, 100));
            }

            const yPct = parsePercent(yArg);

            if (element.tagName.toLowerCase() === "html") {
              const scrollHeight = document.body.scrollHeight;
              const viewportHeight = window.innerHeight;
              const scrollTop = (scrollHeight - viewportHeight) * (yPct / 100);
              window.scrollTo({
                top: scrollTop,
                left: window.scrollX,
                behavior: "smooth",
              });
            } else {
              // Check if element is scrollable
              const scrollHeight = element.scrollHeight;
              const clientHeight = element.clientHeight;
              const isScrollable = scrollHeight > clientHeight;

              if (isScrollable) {
                // Element has scrollable content - scroll within it
                const scrollTop = (scrollHeight - clientHeight) * (yPct / 100);
                element.scrollTo({
                  top: scrollTop,
                  left: element.scrollLeft,
                  behavior: "smooth",
                });
              } else {
                // Element is not scrollable (e.g., iframe) - scroll it into view
                element.scrollIntoView({
                  behavior: "smooth",
                  block: yPct < 30 ? "start" : yPct > 70 ? "end" : "center",
                });
              }
            }
          },
          { yArg: scrollArg }
        );
      }
      break;
    case "nextChunk":
      // Scroll down by one viewport/element height
      await locator.evaluate((element) => {
        const waitForScrollEnd = (el: HTMLElement | Element) =>
          new Promise<void>((resolve) => {
            let last = el.scrollTop ?? 0;
            const check = () => {
              const cur = el.scrollTop ?? 0;
              if (cur === last) return resolve();
              last = cur;
              requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
          });

        const tagName = element.tagName.toLowerCase();

        if (tagName === "html" || tagName === "body") {
          const height = window.visualViewport?.height ?? window.innerHeight;
          window.scrollBy({ top: height, left: 0, behavior: "smooth" });
          const scrollingRoot = (document.scrollingElement ??
            document.documentElement) as HTMLElement;
          return waitForScrollEnd(scrollingRoot);
        }

        const height = (element as HTMLElement).getBoundingClientRect().height;
        (element as HTMLElement).scrollBy({
          top: height,
          left: 0,
          behavior: "smooth",
        });
        return waitForScrollEnd(element);
      });
      break;
    case "prevChunk":
      // Scroll up by one viewport/element height
      await locator.evaluate((element) => {
        const waitForScrollEnd = (el: HTMLElement | Element) =>
          new Promise<void>((resolve) => {
            let last = el.scrollTop ?? 0;
            const check = () => {
              const cur = el.scrollTop ?? 0;
              if (cur === last) return resolve();
              last = cur;
              requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
          });

        const tagName = element.tagName.toLowerCase();

        if (tagName === "html" || tagName === "body") {
          const height = window.visualViewport?.height ?? window.innerHeight;
          window.scrollBy({ top: -height, left: 0, behavior: "smooth" });
          const rootScrollingEl = (document.scrollingElement ??
            document.documentElement) as HTMLElement;
          return waitForScrollEnd(rootScrollingEl);
        }

        const height = (element as HTMLElement).getBoundingClientRect().height;
        (element as HTMLElement).scrollBy({
          top: -height,
          left: 0,
          behavior: "smooth",
        });
        return waitForScrollEnd(element);
      });
      break;
    default: {
      const errorMsg = `Unknown method: ${method}`;
      if (debug) {
        console.error(`[executePlaywrightMethod] ${errorMsg}`);
      }
      throw new Error(errorMsg);
    }
  }

  if (debug) {
    console.log(
      `[executePlaywrightMethod] Successfully executed ${method}(${JSON.stringify(args)})`
    );
  }
}
