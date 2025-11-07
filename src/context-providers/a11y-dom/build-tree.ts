/**
 * Build hierarchical accessibility tree from flat CDP nodes
 */

import type { CDPSession } from "playwright-core";
import {
  AXNode,
  AccessibilityNode,
  RichNode,
  TreeResult,
  EncodedId,
  BackendIdMaps,
  DOMRect,
} from "./types";
import {
  cleanStructuralNodes,
  formatSimplifiedTree,
  isInteractive,
  createEncodedId,
} from "./utils";
import { decorateRoleIfScrollable } from "./scrollable-detection";

/**
 * Convert raw CDP AXNode to simplified AccessibilityNode
 * Optionally decorates role with "scrollable" prefix if element is scrollable
 */
function convertAXNode(
  node: AXNode,
  scrollableIds?: Set<number>
): AccessibilityNode {
  const baseRole = node.role?.value ?? "unknown";

  // Decorate role if element is scrollable
  const role = scrollableIds
    ? decorateRoleIfScrollable(baseRole, node.backendDOMNodeId, scrollableIds)
    : baseRole;

  return {
    role,
    name: node.name?.value,
    description: node.description?.value,
    value: node.value?.value,
    nodeId: node.nodeId,
    backendDOMNodeId: node.backendDOMNodeId,
    parentId: node.parentId,
    childIds: node.childIds,
    properties: node.properties,
  };
}

/**
 * Build a hierarchical accessibility tree from flat CDP nodes
 *
 * @param nodes - Flat array of accessibility nodes from CDP
 * @param tagNameMap - Map of encoded IDs to tag names
 * @param xpathMap - Map of encoded IDs to XPaths
 * @param frameIndex - Frame index for encoded ID generation
 * @param scrollableIds - Set of backend node IDs that are scrollable
 * @returns TreeResult with cleaned tree, simplified text, and maps
 */
export async function buildHierarchicalTree(
  nodes: AXNode[],
  { tagNameMap, xpathMap }: BackendIdMaps,
  frameIndex = 0,
  scrollableIds?: Set<number>,
  debug = false,
  enableVisualMode = false,
  cdpClient?: CDPSession
): Promise<TreeResult> {
  // Convert raw AX nodes to simplified format, decorating scrollable elements
  const accessibilityNodes = nodes.map((node) =>
    convertAXNode(node, scrollableIds)
  );

  // Map to store processed nodes
  const nodeMap = new Map<string, RichNode>();

  // Map to store bounding boxes (only if visual mode enabled)
  const boundingBoxMap = new Map<EncodedId, DOMRect>();

  // Pass 1: Copy and filter nodes we want to keep
  for (const node of accessibilityNodes) {
    // Skip nodes without nodeId or negative pseudo-nodes
    if (!node.nodeId || +node.nodeId < 0) continue;

    // Keep nodes that have:
    // - A name (visible text)
    // - Children (structural importance)
    // - Interactive role
    const keep =
      node.name?.trim() || node.childIds?.length || isInteractive(node);
    if (!keep) continue;

    // Resolve encoded ID - directly construct from frameIndex and backendNodeId
    // EncodedId format is "frameIndex-backendNodeId", no complex lookup needed
    let encodedId: EncodedId | undefined;
    if (node.backendDOMNodeId !== undefined) {
      encodedId = createEncodedId(frameIndex, node.backendDOMNodeId);
    }

    // Store node with encodedId
    const richNode: RichNode = {
      encodedId,
      role: node.role,
      nodeId: node.nodeId,
      ...(node.name && { name: node.name }),
      ...(node.description && { description: node.description }),
      ...(node.value && { value: node.value }),
      ...(node.backendDOMNodeId !== undefined && {
        backendDOMNodeId: node.backendDOMNodeId,
      }),
    };

    nodeMap.set(node.nodeId, richNode);

    // Collect bounding box if visual mode enabled (inline collection for performance)
    if (
      (debug || enableVisualMode) &&
      cdpClient &&
      node.backendDOMNodeId &&
      encodedId
    ) {
      try {
        const { model } = await cdpClient.send("DOM.getBoxModel", {
          backendNodeId: node.backendDOMNodeId,
        });

        if (model?.border && model.border.length >= 8) {
          // Border quad: [x1,y1, x2,y2, x3,y3, x4,y4]
          // Extract bounding box coordinates
          const xs = [
            model.border[0],
            model.border[2],
            model.border[4],
            model.border[6],
          ];
          const ys = [
            model.border[1],
            model.border[3],
            model.border[5],
            model.border[7],
          ];

          const left = Math.min(...xs);
          const top = Math.min(...ys);
          const right = Math.max(...xs);
          const bottom = Math.max(...ys);

          const boundingBox: DOMRect = {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
            top,
            left,
            right,
            bottom,
          };

          // Store in both richNode and boundingBoxMap
          richNode.boundingBox = boundingBox;
          boundingBoxMap.set(encodedId, boundingBox);
        }
      } catch {
        // Skip elements without layout (e.g., hidden elements, pseudo-elements)
        // This is expected and not an error
        if (debug) {
          console.debug(
            `[A11y] Could not get bounding box for node ${encodedId} (backendNodeId=${node.backendDOMNodeId})`
          );
        }
      }
    }
  }

  // Pass 2: Wire parent-child relationships
  for (const node of accessibilityNodes) {
    if (!node.parentId || !node.nodeId) continue;

    const parent = nodeMap.get(node.parentId);
    const current = nodeMap.get(node.nodeId);

    if (parent && current) {
      (parent.children ??= []).push(current);
    }
  }

  // Pass 3: Find root nodes (nodes without parents)
  const roots = accessibilityNodes
    .filter((n) => !n.parentId && n.nodeId && nodeMap.has(n.nodeId))
    .map((n) => nodeMap.get(n.nodeId!)!) as RichNode[];

  // Pass 4: Clean structural nodes
  const cleanedRoots = (
    await Promise.all(roots.map((n) => cleanStructuralNodes(n, tagNameMap)))
  ).filter(Boolean) as AccessibilityNode[];

  // Pass 5: Generate simplified text tree
  const simplified = cleanedRoots.map(formatSimplifiedTree).join("\n");

  // Pass 6: Build idToElement map for quick lookup
  const idToElement = new Map<EncodedId, AccessibilityNode>();

  const collectNodes = (node: RichNode) => {
    if (node.encodedId) {
      idToElement.set(node.encodedId, node);
    }
    node.children?.forEach((child) => collectNodes(child as RichNode));
  };

  cleanedRoots.forEach((root) => collectNodes(root as RichNode));

  return {
    tree: cleanedRoots,
    simplified,
    xpathMap,
    idToElement,
    ...(enableVisualMode && { boundingBoxMap }),
  };
}
