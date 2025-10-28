import { ActionContext } from "@hyperbrowser/agent/types";

/**
 * Get a Playwright locator for an element
 * Supports both visual mode (numeric index) and a11y mode (encoded ID string)
 */
export function getLocator(ctx: ActionContext, elementId: number | string) {
  // Try to get element with original type first
  let element = ctx.domState.elements.get(elementId as any);

  // If not found and elementId is a string, try parsing as number for visual mode
  if (!element && typeof elementId === 'string') {
    const numericId = Number(elementId);
    if (!isNaN(numericId)) {
      element = ctx.domState.elements.get(numericId as any);
    }
  }

  if (!element) {
    return null;
  }

  // Visual mode: element has cssPath and xpath properties
  if ('cssPath' in element && 'xpath' in element) {
    if (element.isUnderShadowRoot) {
      return ctx.page.locator(element.cssPath);
    } else {
      return ctx.page.locator(`xpath=${element.xpath}`);
    }
  }

  // A11y mode: look up xpath from xpathMap using encoded ID
  const xpathMap = (ctx.domState as any).xpathMap;
  if (xpathMap && typeof elementId === 'string' && xpathMap[elementId]) {
    return ctx.page.locator(`xpath=${xpathMap[elementId]}`);
  }

  // Fallback: element not found or no xpath available
  return null;
}
