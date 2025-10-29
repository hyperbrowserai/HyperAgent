/**
 * Types for the tool-based agent architecture
 * Tools are functions that the agent can call to interact with the browser
 */

import { Page } from 'patchright';
import { HyperAgentLLM } from '@/llm/types';

/**
 * Shared context passed to all tools
 * Allows tools to access page, LLM, and share state
 */
export interface ToolContext {
  /** Playwright page instance */
  page: Page;

  /** LLM client for making inference calls */
  llm: HyperAgentLLM;

  /** Logger function */
  logger?: (message: string, data?: any) => void;

  /** Current accessibility tree (cached to avoid re-fetching) */
  currentTree?: string;

  /** Current xpathMap for element location */
  currentXpathMap?: Record<string, string>;

  /** Current elements map */
  currentElements?: Map<string | number, any>;

  /** Task completion flag */
  taskCompleted?: boolean;

  /** Task success status */
  taskSuccess?: boolean;

  /** Task output/result */
  taskOutput?: string;
}

/**
 * Result returned by tool execution
 */
export interface ToolResult {
  /** Whether the tool execution succeeded */
  success: boolean;

  /** Human-readable message describing what happened */
  message: string;

  /** Optional data payload (e.g., extracted data, metrics) */
  data?: any;
}

/**
 * Tool definition interface
 * Each tool must implement this interface
 */
export interface Tool {
  /** Tool name (used by agent to call it) */
  name: string;

  /** Description of what the tool does */
  description: string;

  /** Parameter schema (Zod object) */
  parameters: any;

  /** Execute function that performs the tool's action */
  execute: (params: any, context: ToolContext) => Promise<ToolResult>;
}
