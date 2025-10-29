/**
 * Type verification test to ensure our tools are compatible with AI SDK v5
 */

import { tool } from 'ai';
import { z } from 'zod';

// Simulate our tool pattern
const context = {
  page: {} as any,
  llm: {} as any,
};

// Create a tool exactly like we do
const testTool = tool({
  description: 'Test tool',
  inputSchema: z.object({
    action: z.string()
  }),
  execute: async ({ action }) => {
    return { success: true, message: action };
  }
});

// Check the return type
type TestToolType = typeof testTool;

// This is what our createAgentTools returns
const tools = {
  testTool: testTool,
};

type ToolsObjectType = typeof tools;

// Export to verify types compile
export { testTool, tools };
export type { TestToolType, ToolsObjectType };

console.log('Tool type verification passed!');
console.log('Tool has execute:', 'execute' in testTool);
console.log('Tool has inputSchema:', 'inputSchema' in testTool);
console.log('Tool has description:', 'description' in testTool);
