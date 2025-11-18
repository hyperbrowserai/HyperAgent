/**
 * Build backend ID maps for DOM traversal and xpath generation
 */

import type { CDPSession } from "@/cdp";
import {
  DOMNode,
  BackendIdMaps,
  EncodedId,
  IframeInfo,
  DOMRect,
} from "./types";
import { createEncodedId } from "./utils";

async function annotateIframeBoundingBoxes(
  session: CDPSession,
  frameMap: Map<number, IframeInfo>,
  debug: boolean
): Promise<void> {
  if (!frameMap.size) {
    return;
  }

  for (const [frameIndex, frameInfo] of frameMap.entries()) {
    if (!frameInfo.iframeBackendNodeId) continue;
    try {
      const response = await session.send<{
        model: {
          content?: number[];
        };
      }>("DOM.getBoxModel", {
        backendNodeId: frameInfo.iframeBackendNodeId,
      });
      const content = response?.model?.content;
      if (!content || content.length < 8) continue;

      const xs = [content[0], content[2], content[4], content[6]];
      const ys = [content[1], content[3], content[5], content[7]];
      const left = Math.min(...xs);
      const right = Math.max(...xs);
      const top = Math.min(...ys);
      const bottom = Math.max(...ys);
      const rect: DOMRect = {
        x: left,
        y: top,
        left,
        top,
        right,
        bottom,
        width: right - left,
        height: bottom - top,
      };
      frameInfo.absoluteBoundingBox = rect;
    } catch {
      // error just means it's out of viewport
      // if (debug) {
      //   console.warn(
      //     `[DOM] Failed to compute bounding box for frame ${frameIndex}:`,
      //     error
      //   );
      // }
    }
  }
}

/**
 * Join XPath segments
 */
function joinStep(base: string, step: string): string {
  return base.endsWith("//") ? `${base}${step}` : `${base}/${step}`;
}

/**
 * Extract accessible name from DOM node attributes
 * Prioritizes: aria-label > title > placeholder
 * Returns undefined if no accessible name found
 */
function extractAccessibleName(
  attributes: string[] | undefined
): string | undefined {
  if (!attributes || attributes.length === 0) return undefined;

  let ariaLabel: string | undefined;
  let title: string | undefined;
  let placeholder: string | undefined;

  // CDP attributes are flat array: ["name1", "value1", "name2", "value2"]
  for (let i = 0; i < attributes.length; i += 2) {
    const attrName = attributes[i];
    const attrValue = attributes[i + 1];

    if (attrName === "aria-label" && attrValue) {
      ariaLabel = attrValue;
    } else if (attrName === "title" && attrValue) {
      title = attrValue;
    } else if (attrName === "placeholder" && attrValue) {
      placeholder = attrValue;
    }
  }

  // Return in priority order
  return ariaLabel || title || placeholder;
}

/**
 * Build maps from backend node IDs to tag names and XPaths
 * This is essential for enhancing accessibility nodes with DOM information
 */
export async function buildBackendIdMaps(
  session: CDPSession,
  frameIndex = 0,
  debug = false,
  pierce = true // Default true for main frame, false for OOPIF to avoid capturing transient nested frames
): Promise<BackendIdMaps> {
  try {
    // Step 1: Get full DOM tree from CDP
    // pierce=true: traverses into same-origin iframes (main frame needs this)
    // pierce=false: stops at iframe boundaries (OOPIF processing - nested OOPIFs have their own sessions)
    const { root } = (await session.send("DOM.getDocument", {
      depth: -1,
      pierce,
    })) as { root: DOMNode };

    // Step 2: Initialize maps
    const tagNameMap: Record<EncodedId, string> = {};
    const xpathMap: Record<EncodedId, string> = {};
    const accessibleNameMap: Record<EncodedId, string> = {}; // Maps encodedId -> accessible name
    const backendNodeMap: Record<EncodedId, number> = {};
    const frameMap = new Map<number, IframeInfo>(); // Maps frameIndex -> iframe metadata

    // Debug: Count DOM nodes by frame (only if debug enabled)
    const domNodeCounts = debug ? new Map<number, number>() : null;
    const inputElementsByFrame = debug ? new Map<number, number>() : null;

    // DEBUG: Track encodedId uniqueness (only if debug enabled)
    const encodedIdCounts = debug ? new Map<EncodedId, number>() : null;

    // Step 3: DFS traversal to build maps with frame tracking
    interface StackEntry {
      node: DOMNode;
      path: string;
      currentFrameIndex: number; // Track which frame we're in
    }

    const stack: StackEntry[] = [
      { node: root, path: "", currentFrameIndex: frameIndex },
    ];
    const seen = new Set<EncodedId>();
    let nextFrameIndex = frameIndex + 1; // Counter for iframe indices

    // Track sibling positions for frames with same parent+URL
    // Key: "parentFrameIndex:url", Value: position counter
    const siblingPositions = new Map<string, number>();

    while (stack.length) {
      const { node, path, currentFrameIndex } = stack.pop()!;

      // Skip nodes without backend ID
      if (!node.backendNodeId) continue;

      // Create encoded ID with current frame index
      const encodedId = createEncodedId(currentFrameIndex, node.backendNodeId);

      // DEBUG: Track encodedId creation (only if debug enabled)
      if (debug && encodedIdCounts) {
        encodedIdCounts.set(
          encodedId,
          (encodedIdCounts.get(encodedId) || 0) + 1
        );
        if (encodedIdCounts.get(encodedId)! > 1) {
          console.warn(
            `[buildBackendIdMaps] ⚠️ Duplicate encodedId: "${encodedId}" (frameIndex=${currentFrameIndex}, backendNodeId=${node.backendNodeId}, tagName=${String(node.nodeName).toLowerCase()}), count=${encodedIdCounts.get(encodedId)}`
          );
        }
      }

      // Skip if already seen
      if (seen.has(encodedId)) continue;
      seen.add(encodedId);

      // Store tag name and xpath
      const tagName = String(node.nodeName).toLowerCase();
      tagNameMap[encodedId] = tagName;
      xpathMap[encodedId] = path;
      backendNodeMap[encodedId] = node.backendNodeId;

      // Extract and store accessible name if present
      const accessibleName = extractAccessibleName(node.attributes);
      if (accessibleName) {
        accessibleNameMap[encodedId] = accessibleName;
      }

      // Debug: Count nodes by frame (only if debug enabled)
      if (debug && domNodeCounts) {
        domNodeCounts.set(
          currentFrameIndex,
          (domNodeCounts.get(currentFrameIndex) || 0) + 1
        );
      }

      // Debug: Count input/textarea elements (only if debug enabled)
      if (
        debug &&
        inputElementsByFrame &&
        (tagName === "input" || tagName === "textarea")
      ) {
        inputElementsByFrame.set(
          currentFrameIndex,
          (inputElementsByFrame.get(currentFrameIndex) || 0) + 1
        );
      }

      // Handle iframe content documents (same-origin iframes only)
      // OOPIF (cross-origin) iframes won't have contentDocument due to security restrictions
      if (
        node.nodeName &&
        node.nodeName.toLowerCase() === "iframe" &&
        node.contentDocument
      ) {
        // Assign a new frame index to this same-origin iframe's content
        // This frameIndex is based on DOM traversal order (DFS) and is authoritative
        const iframeFrameIndex = nextFrameIndex++;

        // Extract iframe attributes for frame resolution
        // CDP DOM.getDocument returns attributes as flat array: ["name", "value", "name2", "value2"]
        const attributes = node.attributes || [];
        let iframeSrc: string | undefined;
        let iframeName: string | undefined;

        for (let i = 0; i < attributes.length; i += 2) {
          const attrName = attributes[i];
          const attrValue = attributes[i + 1];

          if (attrName === "src") {
            iframeSrc = attrValue;
          } else if (attrName === "name") {
            iframeName = attrValue;
          }
        }

        // Try to get CDP frameId (typically undefined for same-origin iframes)
        // Same-origin iframes usually don't have a frameId in the DOM.getDocument response
        // because they're pierced inline. We'll match by backendNodeId later in syncFrameContextManager.
        const cdpFrameId = node.contentDocument.frameId;
        if (debug && !cdpFrameId) {
          console.log(
            `[DOM] Same-origin iframe without frameId (expected) - will match by backendNodeId=${node.backendNodeId}`
          );
        }

        // Track sibling position for this iframe
        const siblingKey = `${currentFrameIndex}:${iframeSrc || "no-src"}`;
        const siblingPosition = siblingPositions.get(siblingKey) || 0;
        siblingPositions.set(siblingKey, siblingPosition + 1);

        // Store iframe metadata for later frame resolution
        // Note: cdpFrameId is typically undefined for same-origin iframes in DOM.getDocument response
        // We rely on iframeBackendNodeId for matching in syncFrameContextManager
        const iframeInfo: IframeInfo = {
          frameIndex: iframeFrameIndex,
          src: iframeSrc,
          name: iframeName,
          xpath: path, // XPath to the iframe element itself
          frameId: cdpFrameId, // Usually undefined for same-origin
          cdpFrameId, // Usually undefined for same-origin (kept for debugging)
          parentFrameIndex: currentFrameIndex, // Parent frame
          siblingPosition, // Position among siblings with same parent+URL
          iframeBackendNodeId: node.backendNodeId, // backendNodeId of <iframe> element (PRIMARY matching key)
          contentDocumentBackendNodeId: node.contentDocument.backendNodeId, // backendNodeId of content document root
        };
        frameMap.set(iframeFrameIndex, iframeInfo);

        if (debug) {
          console.log(
            `[DOM] Iframe detected: frameIndex=${iframeFrameIndex}, parent=${currentFrameIndex}, iframeBackendNodeId=${node.backendNodeId}, contentDocBackendNodeId=${node.contentDocument.backendNodeId}, cdpFrameId="${cdpFrameId}", src="${iframeSrc}", siblingPos=${siblingPosition}`
          );
        }

        // Reset path for iframe content (XPath is relative to iframe document)
        stack.push({
          node: node.contentDocument,
          path: "",
          currentFrameIndex: iframeFrameIndex,
        });
      }

      // Handle shadow roots
      if (node.shadowRoots?.length) {
        for (const shadowRoot of node.shadowRoots) {
          stack.push({
            node: shadowRoot,
            path: `${path}//`,
            currentFrameIndex,
          });
        }
      }

      // Process children
      const children = node.children ?? [];
      if (children.length) {
        // Build XPath segments for each child (left-to-right)
        const segments: string[] = [];
        const counter: Record<string, number> = {};

        for (const child of children) {
          const tag = String(child.nodeName).toLowerCase();
          const key = `${child.nodeType}:${tag}`;
          const idx = (counter[key] = (counter[key] ?? 0) + 1);

          if (child.nodeType === 3) {
            // Text node
            segments.push(`text()[${idx}]`);
          } else if (child.nodeType === 8) {
            // Comment node
            segments.push(`comment()[${idx}]`);
          } else {
            // Element node
            // Handle namespaced elements (e.g., "svg:path")
            segments.push(
              tag.includes(":")
                ? `*[name()='${tag}'][${idx}]`
                : `${tag}[${idx}]`
            );
          }
        }

        // Push children in reverse order so traversal remains left-to-right
        for (let i = children.length - 1; i >= 0; i--) {
          stack.push({
            node: children[i]!,
            path: joinStep(path, segments[i]!),
            currentFrameIndex,
          });
        }
      }
    }

    // Debug: Log DOM tree statistics (only if debug enabled)
    if (debug && domNodeCounts && inputElementsByFrame) {
      console.log("[DOM.getDocument] DOM tree statistics:");
      for (const [frameIdx, count] of Array.from(domNodeCounts.entries()).sort(
        (a, b) => a[0] - b[0]
      )) {
        const inputs = inputElementsByFrame.get(frameIdx) || 0;
        const frameInfo = frameMap.get(frameIdx);
        const frameName = frameInfo
          ? frameInfo.src || frameInfo.name || `frame-${frameIdx}`
          : `frame-${frameIdx}`;
        console.log(
          `  Frame ${frameIdx} (${frameName}): ${count} DOM nodes, ${inputs} input/textarea elements`
        );
      }
    }

    await annotateIframeBoundingBoxes(session, frameMap, debug);

    return {
      tagNameMap,
      xpathMap,
      accessibleNameMap,
      backendNodeMap,
      frameMap,
    };
  } catch (error) {
    console.error("Error building backend ID maps:", error);
    return {
      tagNameMap: {},
      xpathMap: {},
      accessibleNameMap: {},
      backendNodeMap: {},
      frameMap: new Map(),
    };
  }
}
