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
import {
  AGENT_ELEMENT_ACTIONS,
  type AgentElementAction,
} from "../shared/action-restrictions";
import { formatUnknownError } from "@/utils";

const MAX_EXAMINE_DOM_DIAGNOSTIC_CHARS = 400;
const MAX_EXAMINE_DOM_IDENTIFIER_CHARS = 128;

function sanitizeExamineDomText(value: string): string {
  if (value.length === 0) {
    return value;
  }
  const withoutControlChars = Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code < 32) || code === 127 ? " " : char;
  }).join("");
  return withoutControlChars.replace(/\s+/g, " ").trim();
}

function truncateExamineDomText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const omittedChars = value.length - maxChars;
  return `${value.slice(0, maxChars)}... [truncated ${omittedChars} chars]`;
}

function formatExamineDomDiagnostic(value: unknown): string {
  const normalized = sanitizeExamineDomText(formatUnknownError(value));
  if (normalized.length === 0) {
    return "unknown error";
  }
  return truncateExamineDomText(normalized, MAX_EXAMINE_DOM_DIAGNOSTIC_CHARS);
}

function formatExamineDomIdentifier(value: unknown): string {
  if (typeof value !== "string") {
    return "unknown";
  }
  const normalized = sanitizeExamineDomText(value);
  if (normalized.length === 0) {
    return "unknown";
  }
  return truncateExamineDomText(normalized, MAX_EXAMINE_DOM_IDENTIFIER_CHARS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeReadRecordField(source: unknown, key: string): unknown {
  if (!isRecord(source)) {
    return undefined;
  }
  try {
    return source[key];
  } catch {
    return undefined;
  }
}

function normalizeParsedElements(parsed: unknown): ExamineDomResult[] {
  const rawElements = safeReadRecordField(parsed, "elements");
  if (!Array.isArray(rawElements)) {
    return [];
  }
  let entries: unknown[];
  try {
    entries = Array.from(rawElements);
  } catch {
    return [];
  }

  const normalized: ExamineDomResult[] = [];
  const supportedMethods = new Set<string>(AGENT_ELEMENT_ACTIONS);
  for (const entry of entries) {
    const elementIdValue = safeReadRecordField(entry, "elementId");
    if (typeof elementIdValue !== "string") {
      continue;
    }
    const elementId = elementIdValue.trim();
    if (elementId.length === 0) {
      continue;
    }
    const confidenceValue = safeReadRecordField(entry, "confidence");
    const confidence =
      typeof confidenceValue === "number" && Number.isFinite(confidenceValue)
        ? confidenceValue
        : 0;
    const descriptionValue = safeReadRecordField(entry, "description");
    const description =
      typeof descriptionValue === "string" ? descriptionValue : "";
    const methodValue = safeReadRecordField(entry, "method");
    let method: AgentElementAction = "click";
    if (typeof methodValue === "string" && supportedMethods.has(methodValue)) {
      method = methodValue as AgentElementAction;
    }
    const argumentsValue = safeReadRecordField(entry, "arguments");
    const argumentsList = Array.isArray(argumentsValue)
      ? argumentsValue
          .map((argument) => (typeof argument === "string" ? argument : ""))
          .filter((argument) => argument.length > 0)
      : [];
    normalized.push({
      elementId,
      confidence,
      description,
      method,
      arguments: argumentsList,
    });
  }
  return normalized;
}

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

    const parsedElements = normalizeParsedElements(response.parsed);
    if (parsedElements.length === 0) {
      // No elements found or parsing failed
      return { elements: [], llmResponse };
    }

    // Sort by confidence descending (highest confidence first)
    const results = parsedElements.sort(
      (a: ExamineDomResult, b: ExamineDomResult) => b.confidence - a.confidence
    );

    // Validate that elementIds exist in the context
    const validatedResults = results.filter((result: ExamineDomResult) => {
      // Check if elementId exists in the provided elements map or xpathMap
      const existsInElements = context.elements.has(result.elementId);
      const existsInXpathMap = context.xpathMap[result.elementId] !== undefined;

      if (!existsInElements && !existsInXpathMap) {
        console.warn(
          `[examineDom] Element ${formatExamineDomIdentifier(
            result.elementId
          )} not found in context, skipping`
        );
        return false;
      }

      return true;
    });

    return { elements: validatedResults, llmResponse };
  } catch (error) {
    console.error(
      `[examineDom] Error finding elements: ${formatExamineDomDiagnostic(
        error
      )}`
    );
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
  const normalizedInstruction = instruction.trim();
  if (normalizedInstruction.length === 0) {
    return "";
  }

  const withMatch = normalizedInstruction.match(/\bwith\s+(.+)$/i);
  if (withMatch) {
    return withMatch[1].trim();
  }

  const intoMatch = normalizedInstruction.match(
    /^(?:fill|type|enter)\s+(.+?)\s+\binto\b/i
  );
  if (intoMatch) {
    return intoMatch[1].trim();
  }

  const inMatch = normalizedInstruction.match(
    /^(?:fill|type|enter)\s+(.+?)\s+\bin\b/i
  );
  if (inMatch) {
    return inMatch[1].trim();
  }

  return "";
}
