/**
 * Accessibility Tree DOM Provider
 * Main entry point for extracting and formatting accessibility trees
 */

import { Page } from 'patchright';
import { A11yDOMState, A11yDOMConfig, AXNode } from './types';
import { buildBackendIdMaps } from './build-maps';
import { buildHierarchicalTree } from './build-tree';
import {
  injectScrollableDetection,
  findScrollableElementIds,
} from './scrollable-detection';

/**
 * Get accessibility tree state from a page
 *
 * This is the main function that:
 * 1. Fetches accessibility tree via CDP
 * 2. Fetches full DOM for xpath mapping
 * 3. Enhances nodes with DOM information
 * 4. Builds simplified text tree
 * 5. Optionally takes screenshot
 *
 * @param page - Playwright page
 * @param config - Configuration options
 * @returns A11yDOMState with elements map and text tree
 */
export async function getA11yDOM(
  page: Page,
  config: A11yDOMConfig = { mode: 'a11y' },
): Promise<A11yDOMState> {
  const mode = config.mode ?? 'a11y';

  try {
    // Step 1: Inject scrollable detection script into page
    await injectScrollableDetection(page);

    // Step 2: Create CDP session
    const client = await page.context().newCDPSession(page);

    try {
      // Step 3: Get accessibility tree from Chrome
      const { nodes } = (await client.send('Accessibility.getFullAXTree')) as {
        nodes: AXNode[];
      };

      // Step 4: Build backend ID maps (tag names and XPaths)
      const maps = await buildBackendIdMaps(client);

      // Step 5: Detect scrollable elements
      const scrollableIds = await findScrollableElementIds(page, client);

      // Step 6: Build hierarchical tree with enhancements and scrollable marking
      const treeResult = await buildHierarchicalTree(nodes, maps, 0, scrollableIds);

      // Step 7: Optionally take screenshot
      let screenshot: string | undefined;
      if (mode === 'hybrid' || mode === 'visual-debug') {
        const screenshotBuffer = await page.screenshot({
          type: 'png',
          fullPage: false,
        });
        screenshot = screenshotBuffer.toString('base64');
      }

      // Step 8: Optionally inject identifiers and draw boxes (visual-debug mode)
      if (mode === 'visual-debug' && config.injectIdentifiers) {
        // TODO: Implement DOM injection and bounding boxes
        // This is Phase 1's optional feature for debugging
        console.warn('visual-debug mode: DOM injection not yet implemented');
      }

      return {
        elements: treeResult.idToElement,
        domState: treeResult.simplified,
        xpathMap: treeResult.xpathMap,
        screenshot,
      };
    } finally {
      // Always detach CDP session
      await client.detach();
    }
  } catch (error) {
    console.error('Error extracting accessibility tree:', error);

    // Fallback to empty state
    return {
      elements: new Map(),
      domState: 'Error: Could not extract accessibility tree',
      xpathMap: {},
      screenshot: undefined,
    };
  }
}

/**
 * Export all types and utilities
 */
export * from './types';
export * from './utils';
export * from './build-maps';
export * from './build-tree';
export * from './scrollable-detection';
