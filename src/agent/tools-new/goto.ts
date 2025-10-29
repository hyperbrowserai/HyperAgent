/**
 * goto Tool
 * Navigates to a specific URL
 */

import { tool } from 'ai';
import { z } from 'zod';
import { ToolContext } from './types';

export const createGotoTool = (context: ToolContext) =>
  tool({
    description:
      'Navigate to a specific URL. Use this to go to a different page or website.',
    inputSchema: z.object({
      url: z
        .string()
        .describe('The URL to navigate to (e.g., "https://example.com")'),
    }),
    execute: async ({ url }) => {
    try {
      context.logger?.(`[goto] Navigating to: ${url}`);

      // Navigate to URL
      await context.page.goto(url, {
        timeout: 30000,
        waitUntil: 'domcontentloaded',
      });

      // Wait for page to be ready
      await context.page.waitForTimeout(1000);

      // Clear cached DOM state (page changed)
      context.currentTree = undefined;
      context.currentXpathMap = undefined;
      context.currentElements = undefined;

      const finalUrl = context.page.url();

      context.logger?.(`[goto] Navigated to: ${finalUrl}`);

      return {
        success: true,
        message: `Successfully navigated to ${finalUrl}`,
        data: {
          url: finalUrl,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      context.logger?.(`[goto] Error: ${errorMsg}`);

      return {
        success: false,
        message: `Failed to navigate to ${url}: ${errorMsg}`,
      };
    }
  },
});
