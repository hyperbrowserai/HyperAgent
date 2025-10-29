/**
 * extract Tool
 * Extracts data from the current page
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getUnifiedDOM } from '@/context-providers/unified-dom';
import { ToolContext } from './types';

export const createExtractTool = (context: ToolContext) =>
  tool({
    description:
      'Extract specific data from the current page. Describe what information you want to extract (e.g., "product prices", "article title and author", "all links").',
    inputSchema: z.object({
      instruction: z
        .string()
        .describe(
          'What data to extract (e.g., "product title and price", "all navigation links")'
        ),
    }),
    execute: async ({ instruction }) => {
    try {
      context.logger?.(`[extract] Extracting: ${instruction}`);

      // Ensure we have current DOM state
      if (!context.currentTree) {
        context.logger?.('[extract] No cached tree, fetching DOM...');
        const domState = await getUnifiedDOM(context.page, { mode: 'a11y' });

        if (!domState) {
          return {
            success: false,
            message: 'Cannot extract: page structure unavailable',
          };
        }

        context.currentTree = domState.domState;
        context.currentXpathMap = domState.xpathMap;
        context.currentElements = domState.elements;
      }

      // Build extraction prompt
      const extractPrompt = `Extract the following information from this accessibility tree:

Instruction: ${instruction}

Accessibility Tree:
${context.currentTree}

Extract the requested information in a clear, structured format. Focus on the semantic content, not HTML details.`;

      // Use LLM to extract data
      const response = await context.llm.invoke([
        {
          role: 'system',
          content:
            'You are a data extraction assistant. Extract the requested information from the accessibility tree provided. Return the data in a clear, structured format.',
        },
        {
          role: 'user',
          content: extractPrompt,
        },
      ]);

      const extractedData = typeof response.content === 'string'
        ? response.content
        : response.content.map(p => p.type === 'text' ? p.text : '').join('');

      context.logger?.(`[extract] Extracted ${extractedData.length} characters`);

      return {
        success: true,
        message: `Extracted data:\n\n${extractedData}`,
        data: {
          instruction,
          extracted: extractedData,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      context.logger?.(`[extract] Error: ${errorMsg}`);

      return {
        success: false,
        message: `Failed to extract data: ${errorMsg}`,
      };
    }
  },
});
