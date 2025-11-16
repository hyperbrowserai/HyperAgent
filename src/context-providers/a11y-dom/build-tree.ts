/**
 * Build hierarchical accessibility tree from flat CDP nodes
 */

import * as fs from "fs";
import * as path from "path";
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
  generateFrameHeader,
} from "./utils";
import { decorateRoleIfScrollable } from "./scrollable-detection";
import {
  batchCollectBoundingBoxesWithFailures,
  BoundingBoxTarget,
} from "./bounding-box-batch";

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
 * @param debug - Whether to collect debug information
 * @param enableVisualMode - Whether to collect bounding boxes for visual overlay
 * @param pageOrFrame - Playwright Page or Frame for batch bounding box collection
 * @param debugDir - Directory to write debug files
 * @returns TreeResult with cleaned tree, simplified text, and maps
 */
export async function buildHierarchicalTree(
  nodes: AXNode[],
  { tagNameMap, xpathMap, frameMap }: BackendIdMaps,
  frameIndex = 0,
  scrollableIds?: Set<number>,
  debug = false,
  enableVisualMode = false,
  boundingBoxTarget?: BoundingBoxTarget,
  debugDir?: string
): Promise<TreeResult> {
  // Convert raw AX nodes to simplified format, decorating scrollable elements
  const accessibilityNodes = nodes.map((node) =>
    convertAXNode(node, scrollableIds)
  );

  // Map to store processed nodes
  const nodeMap = new Map<string, RichNode>();

  // Map to store bounding boxes (only if visual mode enabled)
  let boundingBoxMap = new Map<EncodedId, DOMRect>();
  let boundingBoxFailures: Array<{ encodedId: EncodedId; backendNodeId: number }> = [];

  // Batch collect bounding boxes BEFORE Pass 1 if visual mode enabled
  if ((debug || enableVisualMode) && boundingBoxTarget) {
    // First pass: identify nodes we want to keep and collect their info
    const nodesToCollect: Array<{ backendDOMNodeId?: number; encodedId?: EncodedId }> = [];

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

      // Create encoded ID
      let encodedId: EncodedId | undefined;
      if (node.backendDOMNodeId !== undefined) {
        encodedId = createEncodedId(frameIndex, node.backendDOMNodeId);
      }

      if (node.backendDOMNodeId !== undefined && encodedId) {
        nodesToCollect.push({
          backendDOMNodeId: node.backendDOMNodeId,
          encodedId,
        });
      }
    }

    // Batch collect all bounding boxes in a single CDP call
    if (nodesToCollect.length > 0) {
      const startTime = Date.now();
      const result = await batchCollectBoundingBoxesWithFailures(
        boundingBoxTarget,
        xpathMap,
        nodesToCollect,
        frameIndex,
        frameMap
      );
      const duration = Date.now() - startTime;

      boundingBoxMap = result.boundingBoxMap;
      boundingBoxFailures = result.failures;

      if (debug) {
        console.debug(
          `[A11y] Frame ${frameIndex}: Batch collected ${boundingBoxMap.size}/${nodesToCollect.length} bounding boxes in ${duration}ms (${boundingBoxFailures.length} elements without layout)`
        );
      }

      // Write failures to debug file
      if (debugDir && boundingBoxFailures.length > 0) {
        const failureDetails = boundingBoxFailures
          .map(f => `${f.encodedId} (backendNodeId=${f.backendNodeId})`)
          .join('\n');
        fs.writeFileSync(
          path.join(debugDir, `frame-${frameIndex}-bounding-box-failures.txt`),
          `Failed to get bounding boxes for ${boundingBoxFailures.length} elements:\n\n${failureDetails}\n`
        );
      }
    }
  }

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

    // Attach bounding box if it was collected in batch
    if (encodedId && boundingBoxMap.has(encodedId)) {
      const boundingBox = boundingBoxMap.get(encodedId)!;
      richNode.boundingBox = boundingBox;
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
  const treeContent = cleanedRoots.map(formatSimplifiedTree).join("\n");

  // Pass 5.5: Prepend frame header
  const frameInfo = frameMap?.get(frameIndex);
  const framePath =
    frameInfo?.framePath ||
    (frameIndex === 0 ? ["Main"] : [`Frame ${frameIndex}`]);
  const header = generateFrameHeader(frameIndex, framePath);
  const simplified = `${header}\n${treeContent}`;

  // Pass 6: Build idToElement map for quick lookup
  const idToElement = new Map<EncodedId, AccessibilityNode>();

  const collectNodes = (node: RichNode) => {
    if (node.encodedId) {
      idToElement.set(node.encodedId, node);
    }
    node.children?.forEach((child) => collectNodes(child as RichNode));
  };

  cleanedRoots.forEach((root) => collectNodes(root as RichNode));

  // Pass 7: Build final bounding box map from cleaned tree only
  // This ensures the visual overlay only shows elements that made it through tree cleaning
  const finalBoundingBoxMap = new Map<EncodedId, DOMRect>();
  if (enableVisualMode) {
    for (const encodedId of idToElement.keys()) {
      const boundingBox = boundingBoxMap.get(encodedId);
      if (boundingBox) {
        finalBoundingBoxMap.set(encodedId, boundingBox);
      }
    }
  }

  return {
    tree: cleanedRoots,
    simplified,
    xpathMap,
    idToElement,
    ...(enableVisualMode && { boundingBoxMap: finalBoundingBoxMap }),
  };
}
