import { Page } from "playwright-core";

export const getScrollInfo = async (page: Page): Promise<[number, number]> => {
  // Combine into single evaluate call to reduce IPC overhead
  const { scrollY, viewportHeight, totalHeight } = await page.evaluate(() => ({
    scrollY: window.scrollY,
    viewportHeight: window.innerHeight,
    totalHeight: document.documentElement.scrollHeight,
  }));
  const pixelsAbove = scrollY;
  const pixelsBelow = totalHeight - (scrollY + viewportHeight);
  return [pixelsAbove, pixelsBelow];
};
