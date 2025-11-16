import { z } from "zod";
import { AGENT_ELEMENT_ACTIONS } from "../shared/action-restrictions";

/**
 * Zod schema for a single element match result
 */
export const ExamineDomResultSchema = z.object({
  elementId: z
    .string()
    .describe('The exact elementId from the tree (e.g., "0-1234")'),
  description: z
    .string()
    .describe('Human-readable description of the element'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('Confidence score 0-1 indicating match quality'),
  method: z
    .enum(AGENT_ELEMENT_ACTIONS)
    .default("click")
    .describe('Suggested Playwright method to use'),
  arguments: z
    .array(z.string())
    .default([])
    .describe('Suggested arguments for the method (as strings)'),
});

/**
 * Zod schema for examineDom response (array of results)
 */
export const ExamineDomResultsSchema = z.object({
  elements: z
    .array(ExamineDomResultSchema)
    .describe('Array of matching elements, sorted by confidence (highest first)'),
});

export type ExamineDomResultsType = z.infer<typeof ExamineDomResultsSchema>;
