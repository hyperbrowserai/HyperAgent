/**
 * Shared utility for executing Playwright methods on locators
 * Extracted from HyperAgent.executePlaywrightMethod for reusability
 */

import type { Page } from "playwright-core";
import { formatUnknownError } from "@/utils";

const DEFAULT_CLICK_TIMEOUT_MS = 3_500;
const MAX_CLICK_TIMEOUT_MS = 120_000;
const MAX_METHOD_ARG_CHARS = 20_000;
const MAX_SCROLL_PERCENT_ARG_CHARS = 64;
const MAX_PLAYWRIGHT_METHOD_DIAGNOSTIC_CHARS = 240;

function truncatePlaywrightDiagnostic(value: string): string {
  if (value.length <= MAX_PLAYWRIGHT_METHOD_DIAGNOSTIC_CHARS) {
    return value;
  }
  return `${value.slice(
    0,
    MAX_PLAYWRIGHT_METHOD_DIAGNOSTIC_CHARS
  )}... [truncated ${value.length - MAX_PLAYWRIGHT_METHOD_DIAGNOSTIC_CHARS} chars]`;
}

function stringifyMethodArgs(args: unknown[]): string {
  try {
    return truncatePlaywrightDiagnostic(formatUnknownError(args));
  } catch {
    return "[args unavailable]";
  }
}

function coerceStringArg(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    const normalized = value.length > 0 ? value : fallback;
    if (normalized.length <= MAX_METHOD_ARG_CHARS) {
      return normalized;
    }
    return normalized.slice(0, MAX_METHOD_ARG_CHARS);
  }
  if (value == null) {
    return fallback;
  }
  let coerced: string;
  try {
    coerced = String(value);
  } catch {
    return fallback;
  }
  if (coerced.length === 0) {
    return fallback;
  }
  if (coerced.length <= MAX_METHOD_ARG_CHARS) {
    return coerced;
  }
  return coerced.slice(0, MAX_METHOD_ARG_CHARS);
}

function normalizeMethod(method: unknown): string {
  if (typeof method !== "string") {
    return "";
  }
  return method.trim();
}

function normalizeArgs(args: unknown): unknown[] {
  if (!Array.isArray(args)) {
    throw new Error("[executePlaywrightMethod] args must be an array");
  }
  try {
    return Array.from(args);
  } catch {
    throw new Error("[executePlaywrightMethod] args must be an array");
  }
}

function normalizeClickTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_CLICK_TIMEOUT_MS;
  }
  return Math.min(Math.floor(value), MAX_CLICK_TIMEOUT_MS);
}

function getLocatorMethod(
  locator: ReturnType<Page["locator"]>,
  methodName: string
): (...args: unknown[]) => Promise<unknown> {
  let method: unknown;
  try {
    method = (locator as unknown as Record<string, unknown>)[methodName];
  } catch (error) {
    throw new Error(
      `[executePlaywrightMethod] Failed to access locator.${methodName}: ${truncatePlaywrightDiagnostic(
        formatUnknownError(error)
      )}`
    );
  }
  if (typeof method !== "function") {
    throw new Error(`[executePlaywrightMethod] Missing locator.${methodName} method`);
  }
  return method.bind(locator) as (...args: unknown[]) => Promise<unknown>;
}

async function invokeLocatorMethod(
  locator: ReturnType<Page["locator"]>,
  methodName: string,
  args: unknown[]
): Promise<unknown> {
  const method = getLocatorMethod(locator, methodName);
  try {
    return await method(...args);
  } catch (error) {
    throw new Error(
      `[executePlaywrightMethod] locator.${methodName} failed: ${truncatePlaywrightDiagnostic(
        formatUnknownError(error)
      )}`
    );
  }
}

function normalizeScrollArg(value: unknown): string {
  const normalized = coerceStringArg(value ?? "50%", "50%");
  if (normalized.length <= MAX_SCROLL_PERCENT_ARG_CHARS) {
    return normalized;
  }
  return normalized.slice(0, MAX_SCROLL_PERCENT_ARG_CHARS);
}

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
  const clickTimeout = normalizeClickTimeout(options?.clickTimeout);
  const debug = options?.debug === true;
  const normalizedMethod = normalizeMethod(method);
  const normalizedArgs = normalizeArgs(args);

  switch (normalizedMethod) {
    case "click":
      try {
        await invokeLocatorMethod(locator, "click", [{ timeout: clickTimeout }]);
      } catch (e) {
        const errorMsg = formatUnknownError(e);
        if (debug) {
          console.log(
            `[executePlaywrightMethod] Playwright click failed, falling back to JS click: ${errorMsg}`
          );
        }
        try {
          await invokeLocatorMethod(locator, "evaluate", [
            (el: HTMLElement) => (el as HTMLElement).click(),
            undefined,
          ]);
        } catch (jsClickError) {
          const jsErrorMsg = formatUnknownError(jsClickError);
          throw new Error(
            `Failed to click element. Playwright error: ${errorMsg}. JS click error: ${jsErrorMsg}`
          );
        }
      }
      break;
    case "type":
    case "fill":
      await invokeLocatorMethod(locator, "fill", [
        coerceStringArg(normalizedArgs[0], ""),
      ]);
      break;
    case "selectOptionFromDropdown":
      await invokeLocatorMethod(locator, "selectOption", [
        coerceStringArg(normalizedArgs[0], ""),
      ]);
      break;
    case "hover":
      await invokeLocatorMethod(locator, "hover", []);
      break;
    case "press":
      await invokeLocatorMethod(locator, "press", [
        coerceStringArg(normalizedArgs[0], "Enter"),
      ]);
      break;
    case "check":
      await invokeLocatorMethod(locator, "check", []);
      break;
    case "uncheck":
      await invokeLocatorMethod(locator, "uncheck", []);
      break;
    case "scrollToElement":
      await invokeLocatorMethod(locator, "evaluate", [(element: Element) => {
        if (typeof element.scrollIntoView === "function") {
          element.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }]);
      break;
    case "scrollToPercentage":
      {
        const scrollArg = normalizeScrollArg(normalizedArgs[0]);
        await invokeLocatorMethod(locator, "evaluate", [
          (element: HTMLElement | Element, args: { yArg: string }) => {
            function parsePercent(val: string): number {
              const cleaned = val.trim().replace("%", "");
              const num = parseFloat(cleaned);
              return Number.isNaN(num) ? 0 : Math.max(0, Math.min(num, 100));
            }

            const yPct = parsePercent(args.yArg);

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
              const scrollHeight = element.scrollHeight;
              const clientHeight = element.clientHeight;
              const isScrollable = scrollHeight > clientHeight;

              if (isScrollable) {
                const scrollTop = (scrollHeight - clientHeight) * (yPct / 100);
                element.scrollTo({
                  top: scrollTop,
                  left: element.scrollLeft,
                  behavior: "smooth",
                });
              } else if (typeof element.scrollIntoView === "function") {
                element.scrollIntoView({
                  behavior: "smooth",
                  block: yPct < 30 ? "start" : yPct > 70 ? "end" : "center",
                });
              }
            }
          },
          { yArg: scrollArg },
        ]);
      }
      break;
    case "scrollTo":
      {
        const target = normalizedArgs[0];
        if (target == null) {
          await executePlaywrightMethod("scrollToElement", [], locator);
        } else {
          await executePlaywrightMethod(
            "scrollToPercentage",
            [target],
            locator
          );
        }
      }
      break;
    case "nextChunk":
      // Scroll down by one viewport/element height
      await invokeLocatorMethod(locator, "evaluate", [(element: HTMLElement | Element) => {
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
      }]);
      break;
    case "prevChunk":
      // Scroll up by one viewport/element height
      await invokeLocatorMethod(locator, "evaluate", [(element: HTMLElement | Element) => {
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
      }]);
      break;
    default: {
      const errorMsg = `Unknown method: ${normalizedMethod || formatUnknownError(method)}`;
      if (debug) {
        console.error(`[executePlaywrightMethod] ${errorMsg}`);
      }
      throw new Error(errorMsg);
    }
  }

  if (debug) {
    console.log(
      `[executePlaywrightMethod] Successfully executed ${normalizedMethod}(${stringifyMethodArgs(normalizedArgs)})`
    );
  }
}
