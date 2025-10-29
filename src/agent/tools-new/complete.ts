/**
 * complete Tool
 * Marks the task as complete (success or failure)
 */

import { tool } from 'ai';
import { z } from 'zod';
import { ToolContext } from './types';

export const createCompleteTool = (context: ToolContext) =>
  tool({
    description:
      'Mark the task as complete. Use this when you have accomplished the goal or determined it cannot be completed. Provide a clear explanation of what was accomplished or why it failed.',
    inputSchema: z.object({
      success: z
        .boolean()
        .describe('True if task completed successfully, false if it failed or cannot be completed'),
      message: z
        .string()
        .describe('Detailed explanation of what was accomplished or why it failed'),
    }),
    execute: async ({ success, message }) => {
    context.logger?.(
      `[complete] Task marked as ${success ? 'completed' : 'failed'}: ${message}`
    );

    // Set completion flags in context
    context.taskCompleted = true;
    context.taskSuccess = success;
    context.taskOutput = message;

    return {
      success: true,
      message: `Task ${success ? 'completed successfully' : 'failed'}: ${message}`,
      data: {
        completed: true,
        success,
      },
    };
  },
});
