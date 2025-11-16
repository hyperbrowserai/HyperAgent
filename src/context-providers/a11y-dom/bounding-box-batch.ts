/**
 * Batch bounding box collection utilities
 * Collects bounding boxes for multiple elements in a single browser evaluation
 */

import type { CDPSession } from "@/cdp";
import { ensureScriptInjected } from "@/cdp/script-injector";
import { EncodedId, DOMRect, IframeInfo } from "./types";
import { createEncodedId } from "./utils";

export type BoundingBoxTarget = {
  kind: "cdp";
  session: CDPSession;
  executionContextId?: number;
  frameId: string;
};

function translateBoundingRect(
  rect: DOMRect,
  offsetX: number,
  offsetY: number
): DOMRect {
  if (offsetX === 0 && offsetY === 0) {
    return rect;
  }
  return {
    x: rect.x + offsetX,
    y: rect.y + offsetY,
    width: rect.width,
    height: rect.height,
    top: rect.top + offsetY,
    left: rect.left + offsetX,
    right: rect.right + offsetX,
    bottom: rect.bottom + offsetY,
  };
}

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
      // Viewport filtering is handled later when composing the overlay

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

      // Viewport filtering is handled later when composing the overlay

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
const BOUNDING_BOX_SCRIPT_KEY = "bounding-box-collector";

export async function injectBoundingBoxScriptSession(
  session: CDPSession
): Promise<void> {
  console.debug?.("[BoundingBox] Injecting collection script into session");
  await ensureScriptInjected(
    session,
    BOUNDING_BOX_SCRIPT_KEY,
    boundingBoxCollectionScript
  );
}

async function batchCollectBoundingBoxesViaCDP(
  session: CDPSession,
  executionContextId: number | undefined,
  xpathToBackendId: Map<string, number>,
  frameIndex: number,
  frameId: string,
  frameInfo?: IframeInfo
): Promise<Map<EncodedId, DOMRect>> {
  if (xpathToBackendId.size === 0) {
    return new Map();
  }

  try {
    await ensureScriptInjected(
      session,
      BOUNDING_BOX_SCRIPT_KEY,
      boundingBoxCollectionScript,
      executionContextId
    );

    const xpathToBackendIdObj = Object.fromEntries(xpathToBackendId);
    const response = await session.send<{
      result: { type: string; value?: Record<string, DOMRect> };
    }>("Runtime.callFunctionOn", {
      functionDeclaration:
        "function(xpathMappingJson) { try { const data = JSON.parse(xpathMappingJson); return (window.__hyperagent_collectBoundingBoxesByXPath && window.__hyperagent_collectBoundingBoxesByXPath(data)) || {}; } catch (error) { return {}; } }",
      arguments: [{ value: JSON.stringify(xpathToBackendIdObj) }],
      executionContextId,
      returnByValue: true,
    });

    const boundingBoxes = response.result.value ?? {};
    console.debug?.(
      `[BoundingBox] Frame ${frameIndex}: CDP evaluate returned ${Object.keys(boundingBoxes).length} boxes`
    );
    const offsetLeft =
      frameIndex === 0
        ? 0
        : frameInfo?.absoluteBoundingBox?.left ??
          frameInfo?.absoluteBoundingBox?.x ??
          0;
    const offsetTop =
      frameIndex === 0
        ? 0
        : frameInfo?.absoluteBoundingBox?.top ??
          frameInfo?.absoluteBoundingBox?.y ??
          0;

    const boundingBoxMap = new Map<EncodedId, DOMRect>();

    for (const [backendNodeIdStr, rect] of Object.entries(boundingBoxes)) {
      const backendNodeId = parseInt(backendNodeIdStr, 10);
      const encodedId = createEncodedId(frameIndex, backendNodeId);
      const adjusted =
        frameIndex === 0
          ? (rect as DOMRect)
          : translateBoundingRect(rect as DOMRect, offsetLeft, offsetTop);
      boundingBoxMap.set(encodedId, adjusted);
    }

    return boundingBoxMap;
  } catch (error) {
    console.warn(
      `[A11y] Batch bounding box collection via CDP failed for frame ${frameIndex} (${frameId}):`,
      error
    );
    return new Map();
  }
}

/**
 * Collect bounding boxes for nodes via a CDP session with failure tracking.
 * Returns both successful boxes and a list of failed backend node IDs.
 *
 * @param target - CDP session/configuration for the frame
 * @param xpathMap - Full XPath map (encodedId → xpath)
 * @param nodesToCollect - Nodes with backendDOMNodeId and encodedId
 * @param frameIndex - Frame index for creating encoded IDs
 */
export async function batchCollectBoundingBoxesWithFailures(
  target: BoundingBoxTarget,
  xpathMap: Record<EncodedId, string>,
  nodesToCollect: Array<{ backendDOMNodeId?: number; encodedId?: EncodedId }>,
  frameIndex: number,
  frameMap?: Map<number, IframeInfo>
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
  console.debug?.(
    `[BoundingBox] Frame ${frameIndex}: collecting ${xpathToBackendId.size} boxes via CDP session`
  );
  const boundingBoxMap = await batchCollectBoundingBoxesViaCDP(
    target.session,
    target.executionContextId,
    xpathToBackendId,
    frameIndex,
    target.frameId,
    frameMap?.get(frameIndex)
  );

  // Identify failures (nodes that were requested but not returned)
  const failures: Array<{ encodedId: EncodedId; backendNodeId: number }> = [];

  for (const [encodedId, backendNodeId] of encodedIdToBackendId) {
    if (!boundingBoxMap.has(encodedId)) {
      failures.push({ encodedId, backendNodeId });
    }
  }

  if (failures.length && console.debug) {
    console.debug(
      `[BoundingBox] Frame ${frameIndex}: ${failures.length} bounding box targets missing layout`
    );
  }
  return { boundingBoxMap, failures };
}
