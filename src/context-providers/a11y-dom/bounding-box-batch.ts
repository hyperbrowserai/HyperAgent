/**
 * Batch bounding box collection utilities
 * Collects bounding boxes for multiple elements in a single browser evaluation
 */

import { Page, Frame } from 'playwright-core';
import { EncodedId, DOMRect } from './types';
import { createEncodedId } from './utils';

/**
 * Batch collect bounding boxes for multiple backend node IDs using XPath evaluation
 * This performs a single page.evaluate() call instead of N CDP round-trips
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

    // Execute batch collection in browser context
    const results = await pageOrFrame.evaluate((xpathToBackendIdMapping) => {
      const boundingBoxes: Record<string, {
        x: number;
        y: number;
        width: number;
        height: number;
        top: number;
        left: number;
        right: number;
        bottom: number;
      }> = {};

      for (const [xpath, backendNodeId] of Object.entries(xpathToBackendIdMapping)) {
        try {
          // Evaluate XPath to get the element
          const result = document.evaluate(
            xpath,
            document.documentElement,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          );

          const element = result.singleNodeValue as Element | null;

          // Skip if element not found or doesn't have getBoundingClientRect
          if (!element || typeof (element as any).getBoundingClientRect !== 'function') {
            continue;
          }

          // Get bounding client rect
          const rect = (element as any).getBoundingClientRect();

          // Store with backendNodeId as key (will be converted back to number)
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
          // Skip elements that fail XPath evaluation or bounding box calculation
          // This is expected for detached elements, hidden elements, etc.
          continue;
        }
      }

      return boundingBoxes;
    }, xpathToBackendIdObj);

    // Convert results to Map with EncodedId keys
    const boundingBoxMap = new Map<EncodedId, DOMRect>();

    for (const [backendNodeIdStr, rect] of Object.entries(results)) {
      const backendNodeId = parseInt(backendNodeIdStr, 10);
      const encodedId = createEncodedId(frameIndex, backendNodeId);
      boundingBoxMap.set(encodedId, rect);
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
