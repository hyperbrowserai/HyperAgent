/**
 * Types for examineDom function - finds elements in accessibility tree
 * based on natural language instructions
 */

/**
 * Playwright methods that can be performed on elements
 */
export type PlaywrightMethod =
  | 'click'
  | 'fill'
  | 'type'
  | 'press'
  | 'scrollTo'
  | 'nextChunk'
  | 'prevChunk'
  | 'selectOptionFromDropdown'
  | 'hover'
  | 'check'
  | 'uncheck';

/**
 * Result from examineDom function - represents a matching element
 */
export interface ExamineDomResult {
  /** The element ID in encoded format (e.g., "0-1234") */
  elementId: string;

  /** Human-readable description of the element */
  description: string;

  /** Confidence score 0-1 indicating match quality */
  confidence: number;

  /** Suggested Playwright method to use (optional) */
  method?: PlaywrightMethod;

  /** Suggested arguments for the method (optional) */
  arguments?: any[];
}

/**
 * Context provided to examineDom function
 */
export interface ExamineDomContext {
  /** Current accessibility tree as text */
  tree: string;

  /** Map of elementIds to xpaths for locating elements */
  xpathMap: Record<string, string>;

  /** Map of elementIds to accessibility node objects */
  elements: Map<string, unknown>;

  /** Current page URL */
  url: string;
}
