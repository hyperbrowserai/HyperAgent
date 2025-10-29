/**
 * act Tool
 * Performs actions on the page using natural language
 * Internally uses examineDom to find elements
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getUnifiedDOM } from '@/context-providers/unified-dom';
import { examineDom } from '@/agent/examine-dom';
import { getLocator } from '@/agent/actions/utils';
import { ToolContext } from './types';

export const createActTool = (context: ToolContext) =>
  tool({
    description:
      'Perform an action on the page. Describe the action in natural language. Examples: "click the login button", "fill the email field with test@example.com", "select United States from the country dropdown"',
    inputSchema: z.object({
      action: z
        .string()
        .describe(
          'Natural language description of the action to perform (e.g., "click the submit button")'
        ),
    }),
    execute: async ({ action }) => {
    try {
      context.logger?.(`[act] Performing action: ${action}`);

      // Ensure we have current DOM state (auto-fetch if needed)
      if (!context.currentTree) {
        context.logger?.('[act] No cached tree, fetching DOM...');
        const domState = await getUnifiedDOM(context.page, { mode: 'a11y' });

        if (!domState) {
          return {
            success: false,
            message: 'Cannot perform action: page structure unavailable',
          };
        }

        context.currentTree = domState.domState;
        context.currentXpathMap = domState.xpathMap;
        context.currentElements = domState.elements;
      }

      // Use examineDom to find the element
      const examineDomContext = {
        tree: context.currentTree,
        xpathMap: context.currentXpathMap || {},
        elements: context.currentElements || new Map(),
        url: context.page.url(),
      };

      const results = await examineDom(action, examineDomContext, context.llm);

      if (results.length === 0) {
        context.logger?.(`[act] No element found for: ${action}`);
        return {
          success: false,
          message: `Could not find element for action: "${action}". The element may not exist on the current page.`,
        };
      }

      const bestMatch = results[0];
      context.logger?.(
        `[act] Found element ${bestMatch.elementId} with confidence ${bestMatch.confidence}`
      );

      // Get Playwright locator
      const actionContext = {
        domState: {
          elements: context.currentElements,
          xpathMap: context.currentXpathMap,
          domState: context.currentTree || '',
        } as any,
        page: context.page,
        llm: context.llm,
        tokenLimit: 100000,
        variables: [],
      };

      const locator = getLocator(actionContext, bestMatch.elementId);

      if (!locator) {
        return {
          success: false,
          message: `Found element [${bestMatch.elementId}] but could not create locator`,
        };
      }

      // Execute action based on suggested method
      const method = bestMatch.method || 'click';

      if (method === 'click') {
        await locator.click({ timeout: 5000 });
        return {
          success: true,
          message: `Successfully clicked [${bestMatch.elementId}] ${bestMatch.description}`,
        };
      } else if (method === 'fill') {
        // Extract text from action or use provided arguments
        const text =
          bestMatch.arguments?.[0] || extractTextFromAction(action);
        if (!text) {
          return {
            success: false,
            message: `Cannot fill element: no text value provided in action "${action}"`,
          };
        }
        await locator.fill(text, { timeout: 5000 });
        return {
          success: true,
          message: `Successfully filled [${bestMatch.elementId}] ${bestMatch.description} with "${text}"`,
        };
      } else if (method === 'selectOption') {
        const option =
          bestMatch.arguments?.[0] || extractTextFromAction(action);
        if (!option) {
          return {
            success: false,
            message: `Cannot select option: no value provided in action "${action}"`,
          };
        }
        await locator.selectOption({ label: option }, { timeout: 5000 });
        return {
          success: true,
          message: `Successfully selected "${option}" in [${bestMatch.elementId}] ${bestMatch.description}`,
        };
      } else if (method === 'check' || method === 'uncheck') {
        if (method === 'check') {
          await locator.check({ timeout: 5000 });
        } else {
          await locator.uncheck({ timeout: 5000 });
        }
        return {
          success: true,
          message: `Successfully ${method}ed [${bestMatch.elementId}] ${bestMatch.description}`,
        };
      } else if (method === 'hover') {
        await locator.hover({ timeout: 5000 });
        return {
          success: true,
          message: `Successfully hovered over [${bestMatch.elementId}] ${bestMatch.description}`,
        };
      } else if (method === 'press') {
        const key = bestMatch.arguments?.[0] || 'Enter';
        await locator.press(key, { timeout: 5000 });
        return {
          success: true,
          message: `Successfully pressed ${key} on [${bestMatch.elementId}] ${bestMatch.description}`,
        };
      } else {
        // Default to click
        await locator.click({ timeout: 5000 });
        return {
          success: true,
          message: `Successfully interacted with [${bestMatch.elementId}] ${bestMatch.description}`,
        };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      context.logger?.(`[act] Error: ${errorMsg}`);

      return {
        success: false,
        message: `Failed to perform action "${action}": ${errorMsg}`,
      };
    }
  },
});

/**
 * Extract text value from action string
 * e.g., "fill email with test@example.com" → "test@example.com"
 */
function extractTextFromAction(action: string): string {
  const patterns = [
    /with\s+(.+)$/i,
    /into\s+(.+)$/i,
    /to\s+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = action.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }

  return '';
}
