/**
 * Utility functions for accessibility tree processing
 */

import { AccessibilityNode, EncodedId, RichNode, STRUCTURAL_ROLES } from './types';

/**
 * Clean text by removing private-use unicode characters and normalizing whitespace
 */
export function cleanText(input: string): string {
  if (!input) return '';

  const PUA_START = 0xe000;
  const PUA_END = 0xf8ff;
  const NBSP_CHARS = new Set<number>([0x00a0, 0x202f, 0x2007, 0xfeff]);

  let out = '';
  let prevWasSpace = false;

  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);

    // Skip private-use area glyphs
    if (code >= PUA_START && code <= PUA_END) {
      continue;
    }

    // Convert NBSP-family characters to a single space, collapsing repeats
    if (NBSP_CHARS.has(code)) {
      if (!prevWasSpace) {
        out += ' ';
        prevWasSpace = true;
      }
      continue;
    }

    // Append the character and update space tracker
    out += input[i];
    prevWasSpace = input[i] === ' ';
  }

  // Trim leading/trailing spaces
  return out.trim();
}

/**
 * Format a single accessibility node as a text line
 * Format: [id] role: name
 */
export function formatNodeLine(
  node: AccessibilityNode & { encodedId?: EncodedId },
  level = 0,
): string {
  const indent = '  '.repeat(level);
  const idLabel = node.encodedId ?? node.nodeId ?? 'unknown';
  const namePart = node.name ? `: ${cleanText(node.name)}` : '';

  return `${indent}[${idLabel}] ${node.role}${namePart}`;
}

/**
 * Format accessibility tree as indented text
 * Recursive function to build the tree structure
 */
export function formatSimplifiedTree(
  node: AccessibilityNode & { encodedId?: EncodedId },
  level = 0,
): string {
  const currentLine = formatNodeLine(node, level) + '\n';
  const childrenLines =
    node.children
      ?.map((c) => formatSimplifiedTree(c as typeof node, level + 1))
      .join('') ?? '';

  return currentLine + childrenLines;
}

/**
 * Check if a node is interactive based on role and properties
 */
export function isInteractive(node: AccessibilityNode): boolean {
  // Skip structural-only roles
  if (node.role === 'none' || node.role === 'generic' || node.role === 'InlineTextBox') {
    return false;
  }

  return true;
}

/**
 * Remove redundant StaticText children when parent has same name
 */
export function removeRedundantStaticTextChildren(
  parent: AccessibilityNode,
  children: AccessibilityNode[],
): AccessibilityNode[] {
  if (children.length !== 1) return children;

  const child = children[0];
  if (
    child.role === 'StaticText' &&
    child.name === parent.name &&
    !child.children?.length
  ) {
    return [];
  }

  return children;
}

/**
 * Clean structural nodes by replacing generic roles with tag names
 */
export async function cleanStructuralNodes(
  node: AccessibilityNode & { encodedId?: EncodedId },
  tagNameMap: Record<EncodedId, string>,
): Promise<AccessibilityNode | null> {
  // Ignore negative pseudo-nodes
  if (node.nodeId && +node.nodeId < 0) {
    return null;
  }

  // Handle leaf nodes
  if (!node.children?.length) {
    return node.role === 'generic' || node.role === 'none' ? null : node;
  }

  // Recurse into children
  const cleanedChildren = (
    await Promise.all(
      node.children.map((c) => cleanStructuralNodes(c, tagNameMap)),
    )
  ).filter(Boolean) as AccessibilityNode[];

  // Collapse or prune generic wrappers
  if (node.role === 'generic' || node.role === 'none') {
    if (cleanedChildren.length === 1) {
      // Collapse single-child structural node
      return cleanedChildren[0];
    } else if (cleanedChildren.length === 0) {
      // Remove empty structural node
      return null;
    }
  }

  // Replace generic role with real tag name for better context
  if (
    (node.role === 'generic' || node.role === 'none') &&
    node.encodedId !== undefined
  ) {
    const tagName = tagNameMap[node.encodedId];
    if (tagName) {
      node.role = tagName;
    }
  }

  // Special case: combobox → select
  if (
    node.role === 'combobox' &&
    node.encodedId !== undefined &&
    tagNameMap[node.encodedId] === 'select'
  ) {
    node.role = 'select';
  }

  // Drop redundant StaticText children
  const pruned = removeRedundantStaticTextChildren(node, cleanedChildren);
  if (!pruned.length && (node.role === 'generic' || node.role === 'none')) {
    return null;
  }

  // Return updated node
  return { ...node, children: pruned };
}

/**
 * Generate a short alphanumeric ID from a number
 * Used for creating compact element IDs
 */
export function generateShortId(num: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  let n = num;

  do {
    result = chars[n % chars.length] + result;
    n = Math.floor(n / chars.length);
  } while (n > 0);

  return result;
}

/**
 * Parse encoded ID to extract frame index and backend node ID
 */
export function parseEncodedId(encodedId: EncodedId): { frameIndex: number; backendNodeId: number } {
  const [frameStr, backendStr] = encodedId.split('-');
  return {
    frameIndex: parseInt(frameStr, 10),
    backendNodeId: parseInt(backendStr, 10),
  };
}

/**
 * Create encoded ID from frame index and backend node ID
 */
export function createEncodedId(frameIndex: number, backendNodeId: number): EncodedId {
  return `${frameIndex}-${backendNodeId}`;
}
