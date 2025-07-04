import { ActionContext } from "@hyperbrowser/agent/types";

export function getLocator(ctx: ActionContext, index: number) {
  const locatorString = getLocatorString(ctx, index);
  if (!locatorString) {
    return null;
  }
  return ctx.page.locator(locatorString);
}

export function getLocatorString(ctx: ActionContext, index: number) {
  const element = ctx.domState.elements.get(index);
  if (!element) {
    return null;
  }
  if (element.isUnderShadowRoot) {
    return element.cssPath;
  } else {
    return `xpath=${element.xpath}`;
  }
}
