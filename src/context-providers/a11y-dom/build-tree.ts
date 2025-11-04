/**
 * Build hierarchical accessibility tree from flat CDP nodes
 */

import {
  AXNode,
  AccessibilityNode,
  RichNode,
  TreeResult,
  EncodedId,
  BackendIdMaps,
} from './types';
import { cleanStructuralNodes, formatSimplifiedTree, isInteractive, createEncodedId } from './utils';
import { decorateRoleIfScrollable } from './scrollable-detection';

/**
 * Convert raw CDP AXNode to simplified AccessibilityNode
 * Optionally decorates role with "scrollable" prefix if element is scrollable
 */
function convertAXNode(node: AXNode, scrollableIds?: Set<number>): AccessibilityNode {
  const baseRole = node.role?.value ?? 'unknown';

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
): Promise<TreeResult> {
  // Convert raw AX nodes to simplified format, decorating scrollable elements
  const accessibilityNodes = nodes.map((node) => convertAXNode(node, scrollableIds));

  // Build "backendId → EncodedId[]" lookup
  const backendToIds = new Map<number, EncodedId[]>();
  for (const enc of Object.keys(tagNameMap) as EncodedId[]) {
    const [, backend] = enc.split('-');
    const list = backendToIds.get(+backend) ?? [];
    list.push(enc);
    backendToIds.set(+backend, list);
  }

  // Map to store processed nodes
  const nodeMap = new Map<string, RichNode>();

  // DEBUG: Track encodedId assignment
  const encodedIdAssignments = new Map<EncodedId, number>();

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

    // Resolve encoded ID (unique per backendId)
    let encodedId: EncodedId | undefined;
    if (node.backendDOMNodeId !== undefined) {
      const matches = backendToIds.get(node.backendDOMNodeId) ?? [];

      if (matches.length === 0) {
        // Not in DOM map - generate fallback ID
        encodedId = createEncodedId(frameIndex, node.backendDOMNodeId);
        if (debug) {
          console.log(
            `[buildHierarchicalTree] Frame ${frameIndex}: backendNodeId=${node.backendDOMNodeId} not in DOM map, using fallback encodedId="${encodedId}" (role=${node.role}, nodeId=${node.nodeId})`
          );
        }
      } else {
        // One or more matches - filter by frameIndex to find the correct one
        const framePrefix = `${frameIndex}-`;
        const frameMatch = matches.find(id => id.startsWith(framePrefix));

        if (debug) {
          console.log(
            `[buildHierarchicalTree] Frame ${frameIndex}: backendNodeId=${node.backendDOMNodeId} has ${matches.length} DOM matches: [${matches.join(', ')}] (role=${node.role}, nodeId=${node.nodeId})`
          );
        }

        if (frameMatch) {
          // Found exact match for this frame
          encodedId = frameMatch;
          if (debug) {
            console.log(
              `  ✓ Matched to encodedId="${encodedId}" for frame ${frameIndex}`
            );
          }
        } else {
          // No match for this frame - generate fallback
          encodedId = createEncodedId(frameIndex, node.backendDOMNodeId);
          if (debug) {
            console.log(
              `  ✗ No match for frame ${frameIndex}, using fallback encodedId="${encodedId}"`
            );
          }
        }
      }
    }

    // DEBUG: Track encodedId assignments to detect duplicates
    if (encodedId) {
      encodedIdAssignments.set(encodedId, (encodedIdAssignments.get(encodedId) || 0) + 1);
      if (encodedIdAssignments.get(encodedId)! > 1) {
        console.error(
          `[buildHierarchicalTree] ⚠️ DUPLICATE encodedId assignment: "${encodedId}" assigned ${encodedIdAssignments.get(encodedId)} times (frame ${frameIndex}, backendNodeId=${node.backendDOMNodeId}, role=${node.role})`
        );
      }
    }

    // Store node with encodedId
    nodeMap.set(node.nodeId, {
      encodedId,
      role: node.role,
      nodeId: node.nodeId,
      ...(node.name && { name: node.name }),
      ...(node.description && { description: node.description }),
      ...(node.value && { value: node.value }),
      ...(node.backendDOMNodeId !== undefined && {
        backendDOMNodeId: node.backendDOMNodeId,
      }),
    });
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
    await Promise.all(
      roots.map((n) => cleanStructuralNodes(n, tagNameMap)),
    )
  ).filter(Boolean) as AccessibilityNode[];

  // Pass 5: Generate simplified text tree
  const simplified = cleanedRoots.map(formatSimplifiedTree).join('\n');

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
  };
}
