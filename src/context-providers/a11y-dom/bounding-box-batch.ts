/**
 * Batch bounding box collection utilities
 * Collects bounding boxes for multiple elements in a single browser evaluation
 */

import { Page, Frame } from 'playwright-core';
import { EncodedId, DOMRect } from './types';
import { createEncodedId } from './utils';

/**
 * Browser-side script to collect bounding boxes by backend node IDs
 * Injected once per frame for efficient reuse
 */
export const boundingBoxCollectionScript = `
/**
 * Collect bounding boxes for elements by their backend node IDs
 * Uses CDP's DOM.resolveNode to get elements by backend ID
 *
 * @param backendNodeIds - Array of backend node IDs to collect boxes for
 * @returns Object mapping backend node ID to bounding box
 */
window.__hyperagent_collectBoundingBoxes = function(backendNodeIds) {
  const results = {};

  for (const backendNodeId of backendNodeIds) {
    try {
      // Note: We can't directly access elements by backend node ID in browser context
      // We need to use XPath as the bridge
      // This function will be called with XPath already resolved
      continue;
    } catch {
      continue;
    }
  }

  return results;
};

/**
 * Collect bounding boxes using XPath lookup
 * More efficient than individual CDP calls
 *
 * @param xpathToBackendId - Object mapping XPath to backend node ID
 * @returns Object mapping backend node ID to bounding box
 */
window.__hyperagent_collectBoundingBoxesByXPath = function(xpathToBackendId) {
  const boundingBoxes = {};

  for (const [xpath, backendNodeId] of Object.entries(xpathToBackendId)) {
    try {
      const result = document.evaluate(
        xpath,
        document.documentElement,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );

      const element = result.singleNodeValue;
      if (!element || typeof element.getBoundingClientRect !== 'function') {
        continue;
      }

      const rect = element.getBoundingClientRect();

      // Only include elements that have some size
      if (rect.width === 0 && rect.height === 0) {
        continue;
      }

      boundingBoxes[backendNodeId] = {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
      };
    } catch {
      continue;
    }
  }

  return boundingBoxes;
};
`;

/**
 * Inject bounding box collection script into a frame
 * Should be called once per frame before collecting bounding boxes
 */
export async function injectBoundingBoxScript(pageOrFrame: Page | Frame): Promise<void> {
  try {
    await pageOrFrame.evaluate(boundingBoxCollectionScript);
  } catch (error) {
    console.warn('[A11y] Failed to inject bounding box collection script:', error);
  }
}

/**
 * Batch collect bounding boxes for multiple backend node IDs using XPath evaluation
 * Uses pre-injected script for better performance
 *
 * @param pageOrFrame - Playwright Page or Frame to evaluate in
 * @param xpathToBackendId - Map of XPath strings to backend node IDs
 * @param frameIndex - Frame index for creating encoded IDs
 * @returns Map of encoded IDs to DOMRects
 */
export async function batchCollectBoundingBoxes(
  pageOrFrame: Page | Frame,
  xpathToBackendId: Map<string, number>,
  frameIndex: number
): Promise<Map<EncodedId, DOMRect>> {
  if (xpathToBackendId.size === 0) {
    return new Map();
  }

  try {
    // Convert Map to plain object for serialization
    const xpathToBackendIdObj = Object.fromEntries(xpathToBackendId);

    // Call the injected function (much faster than inline evaluation)
    const results = await pageOrFrame.evaluate((xpathToBackendIdMapping) => {
      // @ts-expect-error - function injected via script
      return window.__hyperagent_collectBoundingBoxesByXPath?.(xpathToBackendIdMapping) ?? {};
    }, xpathToBackendIdObj) as Record<string, DOMRect>;

    // Convert results to Map with EncodedId keys
    const boundingBoxMap = new Map<EncodedId, DOMRect>();

    for (const [backendNodeIdStr, rect] of Object.entries(results)) {
      const backendNodeId = parseInt(backendNodeIdStr, 10);
      const encodedId = createEncodedId(frameIndex, backendNodeId);
      boundingBoxMap.set(encodedId, rect as DOMRect);
    }

    return boundingBoxMap;
  } catch (error) {
    console.warn('[A11y] Batch bounding box collection failed:', error);
    return new Map();
  }
}

/**
 * Collect bounding boxes for nodes, with fallback tracking
 * Returns both successful boxes and a list of failed backend node IDs
 *
 * @param pageOrFrame - Playwright Page or Frame to evaluate in
 * @param xpathMap - Full XPath map (encodedId → xpath)
 * @param nodesToCollect - Array of nodes with backendDOMNodeId and encodedId
 * @param frameIndex - Frame index for creating encoded IDs
 * @returns Object with boundingBoxMap and failures array
 */
export async function batchCollectBoundingBoxesWithFailures(
  pageOrFrame: Page | Frame,
  xpathMap: Record<EncodedId, string>,
  nodesToCollect: Array<{ backendDOMNodeId?: number; encodedId?: EncodedId }>,
  frameIndex: number
): Promise<{
  boundingBoxMap: Map<EncodedId, DOMRect>;
  failures: Array<{ encodedId: EncodedId; backendNodeId: number }>;
}> {
  // Build xpath → backendNodeId mapping for batch collection
  const xpathToBackendId = new Map<string, number>();
  const encodedIdToBackendId = new Map<EncodedId, number>();

  for (const node of nodesToCollect) {
    if (node.backendDOMNodeId !== undefined && node.encodedId) {
      const xpath = xpathMap[node.encodedId];
      if (xpath) {
        xpathToBackendId.set(xpath, node.backendDOMNodeId);
        encodedIdToBackendId.set(node.encodedId, node.backendDOMNodeId);
      }
    }
  }

  // Perform batch collection
  const boundingBoxMap = await batchCollectBoundingBoxes(
    pageOrFrame,
    xpathToBackendId,
    frameIndex
  );

  // Identify failures (nodes that were requested but not returned)
  const failures: Array<{ encodedId: EncodedId; backendNodeId: number }> = [];

  for (const [encodedId, backendNodeId] of encodedIdToBackendId) {
    if (!boundingBoxMap.has(encodedId)) {
      failures.push({ encodedId, backendNodeId });
    }
  }

  return { boundingBoxMap, failures };
}
