/**
 * Shared utility for finding elements via natural language instructions
 * Extracted from findElementWithRetry for reusability
 */

import type { Page } from "playwright-core";
import type { HyperAgentLLM } from "@/llm/types";
import { examineDom } from "../examine-dom";
import type { ExamineDomResult } from "../examine-dom/types";
import {
  getA11yDOM,
  type A11yDOMState,
} from "../../context-providers/a11y-dom";
import { waitForSettledDOM } from "@/utils/waitForSettledDOM";

export interface FindElementOptions {
  /**
   * Maximum number of retries if element not found
   */
  maxRetries?: number;

  /**
   * Delay between retries in milliseconds
   */
  retryDelayMs?: number;

  /**
   * Enable debug logging
   */
  debug?: boolean;
}

export interface FindElementResult {
  success: boolean;
  element?: ExamineDomResult;
  domState: A11yDOMState;
  elementMap: Map<string, unknown>;
  llmResponse?: { rawText: string; parsed: unknown };
}

/**
 * Find an element via natural language instruction with retry logic
 *
 * This function:
 * 1. Waits for DOM to settle
 * 2. Fetches FRESH a11y DOM state
 * 3. Calls examineDom to find the element
 * 4. Retries on failure (with DOM refresh on each attempt)
 *
 * Used by:
 * - findElementWithRetry (aiAction)
 * - actElement action (executeTask agent)
 *
 * @param instruction Natural language instruction (e.g., "click the Login button")
 * @param page Playwright page
 * @param llm LLM instance for examineDom
 * @param options Configuration options
 * @returns Element, DOM state, element map, and LLM response
 * @throws Error if element not found after all retries
 */
export async function findElementWithInstruction(
  instruction: string,
  page: Page,
  llm: HyperAgentLLM,
  options: FindElementOptions = {}
): Promise<FindElementResult> {
  const { maxRetries = 1, retryDelayMs = 1000, debug = false } = options;

  let lastDomState: A11yDOMState | null = null;
  let lastElementMap: Map<string, unknown> | null = null;
  let lastLlmResponse: { rawText: string; parsed: unknown } | undefined;

  // Retry loop with DOM refresh (matches aiAction's findElementWithRetry pattern)
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Wait for DOM to settle (ensures dynamic content like dropdowns have finished loading)
    if (debug) {
      if (attempt === 0) {
        console.log(`[findElement] Waiting for DOM to settle...`);
      } else {
        console.log(
          `[findElement] Retry ${attempt + 1}/${maxRetries}: Waiting for DOM to settle...`
        );
      }
    }
    await waitForSettledDOM(page);

    if (debug) {
      console.log(`[findElement] DOM settled`);
    }

    // Fetch FRESH a11y tree
    const domState = await getA11yDOM(page, debug);
    if (!domState) {
      throw new Error("Failed to fetch page structure");
    }

    if (debug) {
      console.log(
        `[findElement] Fetched a11y tree: ${domState.elements.size} elements`
      );
    }

    // Convert elements map to string-only keys for examineDom
    const elementMap = new Map(
      Array.from(domState.elements).map(([k, v]) => [String(k), v])
    );

    if (debug) {
      console.log(
        `[findElement] Calling examineDom to find element for: "${instruction}"`
      );
    }

    const examineResult = await examineDom(
      instruction,
      {
        tree: domState.domState,
        xpathMap: domState.xpathMap || {},
        elements: elementMap,
        url: page.url(),
      },
      llm
    );

    // Store last attempt's data for error case
    lastDomState = domState;
    lastElementMap = elementMap;
    lastLlmResponse = examineResult?.llmResponse;

    // Check if element was found
    if (examineResult && examineResult.elements.length > 0) {
      // Found it! Break out of retry loop
      if (debug && attempt > 0) {
        console.log(`[findElement] Element found on attempt ${attempt + 1}`);
      }

      return {
        success: true,
        element: examineResult.elements[0],
        domState,
        elementMap,
        llmResponse: examineResult.llmResponse,
      };
    }

    // Retry if not last attempt
    if (attempt < maxRetries - 1) {
      if (debug) {
        console.log(
          `[aiAction] Element not found, retrying in ${retryDelayMs}ms (attempt ${attempt + 1}/${maxRetries})...`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      // DOM settling happens at start of next iteration
    }
  }

  // Max retries reached - return failure with last attempt's data
  return {
    success: false,
    domState: lastDomState!,
    elementMap: lastElementMap!,
    llmResponse: lastLlmResponse,
  };
}
