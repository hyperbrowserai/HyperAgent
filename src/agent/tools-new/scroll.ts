/**
 * scroll Tool
 * Scrolls the page up or down
 */

import { tool } from 'ai';
import { z } from 'zod';
import { ToolContext } from './types';

export const createScrollTool = (context: ToolContext) =>
  tool({
    description:
      'Scroll the page up or down. Use when you need to see content that is not currently visible in the viewport.',
    inputSchema: z.object({
      direction: z
        .enum(['up', 'down'])
        .describe('Direction to scroll: "up" or "down"'),
      amount: z
        .number()
        .optional()
        .describe('Number of pixels to scroll (default: 500)'),
    }),
    execute: async ({ direction, amount = 500 }) => {
    try {
      const scrollAmount = direction === 'down' ? amount : -amount;

      context.logger?.(`[scroll] Scrolling ${direction} ${Math.abs(scrollAmount)}px`);

      // Perform scroll
      await context.page.evaluate((pixels) => {
        window.scrollBy(0, pixels);
      }, scrollAmount);

      // Wait for any dynamic content to load
      await context.page.waitForTimeout(500);

      // Get new scroll position info
      const scrollInfo = await context.page.evaluate(() => {
        return {
          scrollTop: window.scrollY,
          scrollHeight: document.documentElement.scrollHeight,
          clientHeight: window.innerHeight,
        };
      });

      const pixelsAbove = scrollInfo.scrollTop;
      const pixelsBelow =
        scrollInfo.scrollHeight - scrollInfo.scrollTop - scrollInfo.clientHeight;

      // Check if at top or bottom
      const atTop = pixelsAbove === 0;
      const atBottom = pixelsBelow <= 0;

      let statusMsg = '';
      if (atTop) {
        statusMsg = ' (reached top of page)';
      } else if (atBottom) {
        statusMsg = ' (reached bottom of page)';
      }

      return {
        success: true,
        message: `Scrolled ${direction} ${Math.abs(scrollAmount)}px. ${pixelsBelow}px below viewport, ${pixelsAbove}px above${statusMsg}.`,
        data: {
          pixelsAbove,
          pixelsBelow,
          atTop,
          atBottom,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      context.logger?.(`[scroll] Error: ${errorMsg}`);

      return {
        success: false,
        message: `Failed to scroll: ${errorMsg}`,
      };
    }
  },
});
