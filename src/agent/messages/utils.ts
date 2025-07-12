import { Page } from "playwright";

export const getScrollInfo = async (page: Page): Promise<[number, number]> => {
  const scrollY = (await page.evaluate("window.scrollY")) as number;
  const viewportHeight = (await page.evaluate("window.innerHeight")) as number;
  const totalHeight = (await page.evaluate(
    "document.documentElement.scrollHeight",
  )) as number;
  const pixelsAbove = scrollY;
  const pixelsBelow = totalHeight - (scrollY + viewportHeight);
  return [pixelsAbove, pixelsBelow];
};
