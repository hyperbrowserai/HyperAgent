/**
 * Unified DOM provider that switches between visual and accessibility tree modes
 */

import { Page } from 'patchright';
import { getDom as getVisualDom } from './dom';
import { getA11yDOM } from './a11y-dom';
import { DOMState } from './dom/types';
import { A11yDOMState, EncodedId } from './a11y-dom/types';
import { DOMConfig } from '@/types/config';

/**
 * Unified DOM state that works with both visual and a11y modes
 * This allows the agent to work with both approaches seamlessly
 */
export interface UnifiedDOMState {
  /**
   * Map of element IDs to element data
   * - Visual mode: numeric indices (1, 2, 3...)
   * - A11y mode: encoded IDs ("0-1234", "0-5678"...)
   */
  elements: Map<number | string, any>;

  /**
   * Text representation of the DOM sent to LLM
   */
  domState: string;

  /**
   * Screenshot (base64 PNG)
   * - Visual mode: Always includes screenshot with overlays
   * - A11y mode: Only in hybrid/visual-debug modes
   */
  screenshot?: string;

  /**
   * Mode used for extraction
   */
  mode: 'visual' | 'a11y' | 'hybrid' | 'visual-debug';

  /**
   * XPath map for a11y mode (used for element location)
   */
  xpathMap?: Record<EncodedId, string>;
}

/**
 * Get DOM state using the configured mode
 *
 * @param page - Playwright page
 * @param config - DOM extraction configuration
 * @returns Unified DOM state that works with both modes
 */
export async function getUnifiedDOM(
  page: Page,
  config?: DOMConfig,
): Promise<UnifiedDOMState | null> {
  const mode = config?.mode ?? 'visual';

  try {
    if (mode === 'visual') {
      // Use current visual DOM implementation
      const visualState = await getVisualDom(page);
      if (!visualState) return null;

      return {
        elements: visualState.elements,
        domState: visualState.domState,
        screenshot: visualState.screenshot,
        mode: 'visual',
      };
    } else {
      // Use new accessibility tree implementation
      const a11yState = await getA11yDOM(page, { mode });

      // Convert EncodedId keys to strings for unified interface
      const elements = new Map<string, any>();
      for (const [id, element] of a11yState.elements) {
        elements.set(id, element);
      }

      return {
        elements,
        domState: a11yState.domState,
        xpathMap: a11yState.xpathMap,
        screenshot: a11yState.screenshot,
        mode,
      };
    }
  } catch (error) {
    console.error(`Error extracting DOM in ${mode} mode:`, error);
    return null;
  }
}
