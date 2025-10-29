/**
 * getDOM Tool
 * Fetches the current page's accessibility tree on-demand
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getUnifiedDOM } from '@/context-providers/unified-dom';
import { ToolContext } from './types';

export const createGetDOMTool = (context: ToolContext) =>
  tool({
    description:
      'Get the accessibility tree of the current page. Use this to understand what elements are available before taking actions. The tree shows all interactive elements with their IDs, roles, and names.',
    inputSchema: z.object({}),
    execute: async () => {
      try {
        // Fetch accessibility tree
        const domState = await getUnifiedDOM(context.page, { mode: 'a11y' });

        if (!domState) {
          return {
            success: false,
            message: 'Failed to fetch page structure',
          };
        }

        // Store in context for other tools to use (avoid re-fetching)
        context.currentTree = domState.domState;
        context.currentXpathMap = domState.xpathMap;
        context.currentElements = domState.elements;

        // Truncate if too long
        let tree = domState.domState;
        const MAX_LENGTH = 50000;
        if (tree.length > MAX_LENGTH) {
          tree =
            tree.substring(0, MAX_LENGTH) +
            '\n\n[TRUNCATED: Tree too large. Showing first 50,000 characters.]';
        }

        context.logger?.(
          `[getDOM] Fetched accessibility tree: ${domState.elements.size} elements`
        );

        return {
          success: true,
          message: `Current page structure:\n\n${tree}\n\nURL: ${context.page.url()}`,
          data: {
            url: context.page.url(),
            elementCount: domState.elements.size,
          },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        context.logger?.(`[getDOM] Error: ${errorMsg}`);

        return {
          success: false,
          message: `Failed to fetch page structure: ${errorMsg}`,
        };
      }
    },
  });
