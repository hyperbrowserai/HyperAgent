/**
 * Types for examineDom function - finds elements in accessibility tree
 * based on natural language instructions
 */

import { ExamineDomResultSchema } from "./schema";
import { z } from "zod";
import type { AccessibilityNode } from "@/context-providers/a11y-dom/types";

/**
 * Playwright methods that can be performed on elements
 */
export type PlaywrightMethod =
  | "click"
  | "fill"
  | "type"
  | "press"
  | "scrollToElement"
  | "scrollToPercentage"
  | "nextChunk"
  | "prevChunk"
  | "selectOptionFromDropdown"
  | "hover"
  | "check"
  | "uncheck";

export type ExamineDomResult = z.infer<typeof ExamineDomResultSchema>;

/**
 * Context provided to examineDom function
 */
export interface ExamineDomContext {
  /** Current accessibility tree as text */
  tree: string;

  /** Map of elementIds to xpaths for locating elements */
  xpathMap: Record<string, string>;

  /** Map of elementIds to accessibility node objects */
  elements: Map<string, AccessibilityNode>;

  /** Current page URL */
  url: string;
}
