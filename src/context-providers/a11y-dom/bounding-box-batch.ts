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

      // For viewport checks: In iframe contexts, window.innerWidth/innerHeight
      // refers to the iframe's viewport, but getBoundingClientRect() returns
      // coordinates relative to the main viewport. So we skip strict viewport
      // filtering in iframes and rely on the main frame's viewport filtering.
      const isInIframe = window.self !== window.top;

      if (!isInIframe) {
        // Main frame: use strict viewport check
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        if (rect.right <= 0 || rect.bottom <= 0 ||
            rect.left >= viewportWidth || rect.top >= viewportHeight) {
          continue;
        }
      }
      // In iframes: skip viewport check, let elements through
      // (they'll be filtered by main frame viewport check later if needed)

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
    } catch (error) {
      // Silently skip elements that fail
      continue;
    }
  }

  return boundingBoxes;
};

/**
 * Collect bounding boxes for same-origin iframe elements by navigating through iframe chain
 * This function runs in the main page context and navigates to iframes using XPaths
 *
 * @param elementsData - Array of {xpath, backendNodeId, frameXPaths}
 * @returns Object mapping backend node ID to bounding box
 */
window.__hyperagent_collectBoundingBoxesForSameOriginIframe = function(elementsData) {
  const boundingBoxes = {};

  for (const {xpath, backendNodeId, frameXPaths} of elementsData) {
    try {
      // Navigate to the target frame document and track iframe offset
      let contextDocument = document;
      let offsetX = 0;
      let offsetY = 0;

      if (frameXPaths && frameXPaths.length > 0) {
        // Walk through iframe chain using XPaths and accumulate offsets
        for (let i = 0; i < frameXPaths.length; i++) {
          const iframeXPath = frameXPaths[i];

          const iframeResult = contextDocument.evaluate(
            iframeXPath,
            contextDocument.documentElement,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          );

          const iframeElement = iframeResult.singleNodeValue;

          if (!iframeElement || !iframeElement.contentDocument) {
            contextDocument = null;
            break;
          }

          // Get iframe's position relative to its parent document
          const iframeRect = iframeElement.getBoundingClientRect();
          // Add the iframe's border offset (clientLeft/clientTop accounts for borders)
          offsetX += iframeRect.left + (iframeElement.clientLeft || 0);
          offsetY += iframeRect.top + (iframeElement.clientTop || 0);

          contextDocument = iframeElement.contentDocument;
        }

        if (!contextDocument) {
          continue;
        }
      }

      // Now evaluate the element's XPath in the iframe document
      const result = contextDocument.evaluate(
        xpath,
        contextDocument.documentElement,
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

      // Translate coordinates from iframe to main page viewport
      // Add accumulated iframe offsets to get coordinates relative to main page
      const translatedLeft = rect.left + offsetX;
      const translatedTop = rect.top + offsetY;
      const translatedRight = rect.right + offsetX;
      const translatedBottom = rect.bottom + offsetY;

      // For viewport checks: use main page viewport dimensions
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      if (translatedRight <= 0 || translatedBottom <= 0 ||
          translatedLeft >= viewportWidth || translatedTop >= viewportHeight) {
        continue;
      }

      boundingBoxes[backendNodeId] = {
        x: translatedLeft,
        y: translatedTop,
        width: rect.width,
        height: rect.height,
        top: translatedTop,
        left: translatedLeft,
        right: translatedRight,
        bottom: translatedBottom,
      };
    } catch (error) {
      // Silently skip elements that fail
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
 * Build frame XPath chain for navigating to a target frame
 * Returns array of iframe XPaths from main frame to target frame
 *
 * @param frameMap - Map of frame indices to IframeInfo
 * @param targetFrameIndex - Target frame index
 * @returns Array of iframe XPaths to traverse (empty for main frame)
 */
function buildFrameXPathChain(
  frameMap: Map<number, import('./types').IframeInfo>,
  targetFrameIndex: number
): string[] {
  if (targetFrameIndex === 0) {
    return []; // Main frame needs no navigation
  }

  // Build frame path by walking parent chain
  const framePath: number[] = [];
  let currentIdx: number | null = targetFrameIndex;
  const visited = new Set<number>();

  while (currentIdx !== null && currentIdx !== 0 && !visited.has(currentIdx)) {
    visited.add(currentIdx);
    framePath.unshift(currentIdx);

    const frameInfo = frameMap.get(currentIdx);
    if (!frameInfo) break;

    currentIdx = frameInfo.parentFrameIndex;
  }

  // Build XPath chain from frame path
  const xpathChain: string[] = [];
  for (const frameIdx of framePath) {
    const frameInfo = frameMap.get(frameIdx);
    if (frameInfo?.xpath) {
      xpathChain.push(frameInfo.xpath);
    }
  }

  return xpathChain;
}

/**
 * Batch collect bounding boxes for same-origin iframe elements
 * Navigates through iframe chain using XPaths in the browser
 *
 * @param page - Main Playwright Page
 * @param xpathToBackendId - Map of XPath strings to backend node IDs
 * @param frameIndex - Frame index for creating encoded IDs
 * @param frameMap - Map of frame indices to IframeInfo
 * @returns Map of encoded IDs to DOMRects
 */
async function batchCollectBoundingBoxesForSameOriginIframe(
  page: Page | Frame,
  xpathToBackendId: Map<string, number>,
  frameIndex: number,
  frameMap: Map<number, import('./types').IframeInfo>
): Promise<Map<EncodedId, DOMRect>> {
  if (xpathToBackendId.size === 0) {
    return new Map();
  }

  try {
    // Build frame XPath chain for navigation
    const frameXPaths = buildFrameXPathChain(frameMap, frameIndex);

    // Build elements data array with frame navigation info
    const elementsData = Array.from(xpathToBackendId.entries()).map(
      ([xpath, backendNodeId]) => ({
        xpath,
        backendNodeId,
        frameXPaths,
      })
    );

    // Get the main page (in case page is actually a frame)
    let mainPage: Page;
    if ('mainFrame' in page) {
      mainPage = page as Page;
    } else {
      // If we got a Frame, get its page
      mainPage = (page as Frame).page();
    }

    // Call the injected function on the main page
    const boundingBoxes = (await mainPage.evaluate((elementsDataArray) => {
      // @ts-expect-error - function injected via script
      return window.__hyperagent_collectBoundingBoxesForSameOriginIframe?.(elementsDataArray) ?? {};
    }, elementsData)) as Record<string, DOMRect>;

    // Convert results to Map with EncodedId keys
    const boundingBoxMap = new Map<EncodedId, DOMRect>();

    for (const [backendNodeIdStr, rect] of Object.entries(boundingBoxes)) {
      const backendNodeId = parseInt(backendNodeIdStr, 10);
      const encodedId = createEncodedId(frameIndex, backendNodeId);
      boundingBoxMap.set(encodedId, rect as DOMRect);
    }

    return boundingBoxMap;
  } catch (error) {
    console.warn(
      `[A11y] Batch bounding box collection failed for same-origin iframe ${frameIndex}:`,
      error
    );
    return new Map();
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
    const boundingBoxes = await pageOrFrame.evaluate((xpathToBackendIdMapping) => {
      // @ts-expect-error - function injected via script
      return window.__hyperagent_collectBoundingBoxesByXPath?.(xpathToBackendIdMapping) ?? {};
    }, xpathToBackendIdObj) as Record<string, DOMRect>;

    // Convert results to Map with EncodedId keys
    const boundingBoxMap = new Map<EncodedId, DOMRect>();

    for (const [backendNodeIdStr, rect] of Object.entries(boundingBoxes)) {
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
 * @param frameMap - Optional frame map for same-origin iframe navigation
 * @returns Object with boundingBoxMap and failures array
 */
export async function batchCollectBoundingBoxesWithFailures(
  pageOrFrame: Page | Frame,
  xpathMap: Record<EncodedId, string>,
  nodesToCollect: Array<{ backendDOMNodeId?: number; encodedId?: EncodedId }>,
  frameIndex: number,
  frameMap?: Map<number, import('./types').IframeInfo>
): Promise<{
  boundingBoxMap: Map<EncodedId, DOMRect>;
  failures: Array<{ encodedId: EncodedId; backendNodeId: number }>;
}> {
  // Check if this is a same-origin iframe (needs frame path navigation)
  const isSameOriginIframe =
    frameIndex !== 0 &&
    frameMap &&
    frameMap.get(frameIndex) &&
    !frameMap.get(frameIndex)?.playwrightFrame;

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
  let boundingBoxMap: Map<EncodedId, DOMRect>;

  if (isSameOriginIframe && frameMap) {
    // Same-origin iframe: need to navigate through iframe chain using XPaths
    boundingBoxMap = await batchCollectBoundingBoxesForSameOriginIframe(
      pageOrFrame,
      xpathToBackendId,
      frameIndex,
      frameMap
    );
  } else {
    // OOPIF or main frame: use current behavior
    boundingBoxMap = await batchCollectBoundingBoxes(
      pageOrFrame,
      xpathToBackendId,
      frameIndex
    );
  }

  // Identify failures (nodes that were requested but not returned)
  const failures: Array<{ encodedId: EncodedId; backendNodeId: number }> = [];

  for (const [encodedId, backendNodeId] of encodedIdToBackendId) {
    if (!boundingBoxMap.has(encodedId)) {
      failures.push({ encodedId, backendNodeId });
    }
  }

  return { boundingBoxMap, failures };
}
