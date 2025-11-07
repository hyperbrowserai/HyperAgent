/**
 * ExamineDom - Find elements in accessibility tree based on natural language
 *
 * Takes a natural language instruction (e.g., "click the login button") and returns
 * matching elements from the accessibility tree with confidence scores.
 */

import { HyperAgentLLM } from "@/llm/types";
import { ExamineDomContext, ExamineDomResult } from "./types";
import {
  buildExamineDomSystemPrompt,
  buildExamineDomUserPrompt,
} from "./prompts";
import { ExamineDomResultsSchema, ExamineDomResultsType } from "./schema";

/**
 * Find elements in the accessibility tree that match the given instruction
 *
 * @param instruction - Natural language instruction (e.g., "click the login button")
 * @param context - Current page context with accessibility tree
 * @param llm - LLM client for making inference calls
 * @returns Object with matching elements and LLM response
 *
 * @example
 * ```typescript
 * const { elements, llmResponse } = await examineDom(
 *   "click the login button",
 *   {
 *     tree: "[0-1234] button: Login\n[0-5678] button: Sign Up",
 *     xpathMap: { "0-1234": "/html/body/button[1]" },
 *     elements: new Map(),
 *     url: "https://example.com"
 *   },
 *   llmClient
 * );
 *
 * // Returns: { elements: [...], llmResponse: { rawText: "...", parsed: {...} } }
 * ```
 */
export async function examineDom(
  instruction: string,
  context: ExamineDomContext,
  llm: HyperAgentLLM
): Promise<{
  elements: ExamineDomResultsType["elements"];
  llmResponse: { rawText: string; parsed: unknown };
}> {
  // Build prompts for element finding
  const systemPrompt = buildExamineDomSystemPrompt();
  const userPrompt = buildExamineDomUserPrompt(instruction, context.tree);

  try {
    // Call LLM with structured output to find elements
    const response = await llm.invokeStructured(
      {
        schema: ExamineDomResultsSchema,
        options: {
          temperature: 0, // Deterministic for element finding
        },
      },
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ]
    );

    const llmResponse = {
      rawText: response.rawText,
      parsed: response.parsed,
    };

    if (!response.parsed || !response.parsed.elements) {
      // No elements found or parsing failed
      return { elements: [], llmResponse };
    }

    // Sort by confidence descending (highest confidence first)
    const results = response.parsed.elements.sort(
      (a: ExamineDomResult, b: ExamineDomResult) => b.confidence - a.confidence
    );

    // Validate that elementIds exist in the context
    const validatedResults = results.filter((result: ExamineDomResult) => {
      // Check if elementId exists in the provided elements map or xpathMap
      const existsInElements = context.elements.has(result.elementId);
      const existsInXpathMap = context.xpathMap[result.elementId] !== undefined;

      if (!existsInElements && !existsInXpathMap) {
        console.warn(
          `[examineDom] Element ${result.elementId} not found in context, skipping`
        );
        return false;
      }

      return true;
    });

    return { elements: validatedResults, llmResponse };
  } catch (error) {
    console.error("[examineDom] Error finding elements:", error);
    // Return empty result on error (graceful degradation)
    return {
      elements: [],
      llmResponse: {
        rawText: "",
        parsed: null,
      },
    };
  }
}

/**
 * Extract text value from instruction for fill actions
 *
 * Extracts the value to be filled from instructions like:
 * - "fill email with test@example.com" → "test@example.com"
 * - "type hello into search box" → "hello"
 * - "enter password123 in password field" → "password123"
 *
 * @param instruction - The natural language instruction
 * @returns The extracted value or empty string if no value found
 */
export function extractValueFromInstruction(instruction: string): string {
  // Pattern: "with X", "into X", "in X"
  const patterns = [/with\s+(.+)$/i, /into\s+(.+)$/i, /in\s+(.+)$/i];

  for (const pattern of patterns) {
    const match = instruction.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }

  return "";
}
