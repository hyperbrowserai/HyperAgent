/**
 * Tool Registry
 * Exports all tools for the agent to use
 */

import { createGetDOMTool } from './getDOM';
import { createActTool } from './act';
import { createCompleteTool } from './complete';
import { createScrollTool } from './scroll';
import { createExtractTool } from './extract';
import { createGotoTool } from './goto';
import { ToolContext } from './types';

/**
 * Creates all tools with the given context
 * This allows tools to share state and access page/llm
 */
export function createAgentTools(context: ToolContext) {
  return {
    getDOM: createGetDOMTool(context),
    act: createActTool(context),
    complete: createCompleteTool(context),
    scroll: createScrollTool(context),
    extract: createExtractTool(context),
    goto: createGotoTool(context),
  };
}

// Re-export types for convenience
export type { ToolContext, ToolResult, Tool } from './types';
