/**
 * Build backend ID maps for DOM traversal and xpath generation
 */

import { CDPSession } from 'patchright';
import { DOMNode, BackendIdMaps, EncodedId } from './types';
import { createEncodedId } from './utils';

/**
 * Lowercase helper
 */
function lc(str: string): string {
  return str.toLowerCase();
}

/**
 * Join XPath segments
 */
function joinStep(base: string, step: string): string {
  return base.endsWith('//') ? `${base}${step}` : `${base}/${step}`;
}

/**
 * Build maps from backend node IDs to tag names and XPaths
 * This is essential for enhancing accessibility nodes with DOM information
 */
export async function buildBackendIdMaps(
  session: CDPSession,
  frameIndex = 0,
): Promise<BackendIdMaps> {
  try {
    // Step 1: Get full DOM tree from CDP
    const { root } = (await session.send('DOM.getDocument', {
      depth: -1,
      pierce: true,
    })) as { root: DOMNode };

    // Step 2: Initialize maps
    const tagNameMap: Record<EncodedId, string> = {};
    const xpathMap: Record<EncodedId, string> = {};

    // Step 3: DFS traversal to build maps
    interface StackEntry {
      node: DOMNode;
      path: string;
    }

    const stack: StackEntry[] = [{ node: root, path: '' }];
    const seen = new Set<EncodedId>();

    while (stack.length) {
      const { node, path } = stack.pop()!;

      // Skip nodes without backend ID
      if (!node.backendNodeId) continue;

      // Create encoded ID
      const encodedId = createEncodedId(frameIndex, node.backendNodeId);

      // Skip if already seen
      if (seen.has(encodedId)) continue;
      seen.add(encodedId);

      // Store tag name and xpath
      tagNameMap[encodedId] = lc(String(node.nodeName));
      xpathMap[encodedId] = path;

      // Handle iframe content documents
      if (node.nodeName && lc(node.nodeName) === 'iframe' && node.contentDocument) {
        // For simplicity, we treat iframe content as part of the same tree
        // In production, might want to handle cross-origin iframes differently
        stack.push({ node: node.contentDocument, path: '' });
      }

      // Handle shadow roots (experimental)
      if (node.shadowRoots?.length) {
        for (const shadowRoot of node.shadowRoots) {
          stack.push({
            node: shadowRoot,
            path: `${path}//`,
          });
        }
      }

      // Process children
      const kids = node.children ?? [];
      if (kids.length) {
        // Build XPath segments for each child (left-to-right)
        const segments: string[] = [];
        const counter: Record<string, number> = {};

        for (const child of kids) {
          const tag = lc(String(child.nodeName));
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
              tag.includes(':')
                ? `*[name()='${tag}'][${idx}]`
                : `${tag}[${idx}]`,
            );
          }
        }

        // Push children in reverse order so traversal remains left-to-right
        for (let i = kids.length - 1; i >= 0; i--) {
          stack.push({
            node: kids[i]!,
            path: joinStep(path, segments[i]!),
          });
        }
      }
    }

    return { tagNameMap, xpathMap };
  } catch (error) {
    console.error('Error building backend ID maps:', error);
    return { tagNameMap: {}, xpathMap: {} };
  }
}
