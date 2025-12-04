/**
 * Structural DOM hashing - extracts structure (tags, roles, hierarchy)
 * while ignoring text content for cache-stable fingerprinting.
 *
 * The accessibility tree format is:
 *   [encodedId] role: visible text name
 *
 * Structural hash includes: [encodedId] role (and hierarchy via indentation)
 * Content hash includes: just the visible text names (for verification if needed)
 */

import { Page } from "playwright-core";
import { sha256 } from "@/utils/hash";

/**
 * Pattern to match accessibility tree lines:
 * Captures: indentation, id, role, and optional name
 * Format: "  [0-123] button: Click me"
 */
const A11Y_LINE_PATTERN = /^(\s*)(\[\d+-\d+\])\s+([^:]+)(?::\s*(.*))?$/;

/**
 * Pattern to match frame headers like "=== Frame 0 (Main) ==="
 */
const FRAME_HEADER_PATTERN = /^===\s*Frame\s+\d+.*===$/;

export interface StructuralHashResult {
  /** Hash of DOM structure only (roles, IDs, hierarchy) */
  structuralHash: string;
  /** Hash of text content only (names, values) - for verification */
  contentHash: string;
  /** Combined hash matching legacy behavior */
  fullHash: string;
}

/**
 * Extract structural representation from accessibility tree
 * Strips text content, keeps only structure (ids, roles, indentation)
 */
export function extractStructure(domState: string): string {
  const lines = domState.split("\n");
  const structuralLines: string[] = [];

  for (const line of lines) {
    // Preserve frame headers as structure
    if (FRAME_HEADER_PATTERN.test(line.trim())) {
      structuralLines.push(line.trim());
      continue;
    }

    // Parse accessibility node lines
    const match = line.match(A11Y_LINE_PATTERN);
    if (match) {
      const [, indent, id, role] = match;
      // Emit structure only: indent + id + role (no text content)
      structuralLines.push(`${indent}${id} ${role.trim()}`);
    }
    // Skip lines that don't match the pattern (empty lines, etc.)
  }

  return structuralLines.join("\n");
}

/**
 * Extract text content from accessibility tree
 * For verification/debugging purposes
 */
export function extractContent(domState: string): string {
  const lines = domState.split("\n");
  const contentParts: string[] = [];

  for (const line of lines) {
    // Skip frame headers
    if (FRAME_HEADER_PATTERN.test(line.trim())) {
      continue;
    }

    // Parse accessibility node lines
    const match = line.match(A11Y_LINE_PATTERN);
    if (match) {
      const [, , , , name] = match;
      if (name?.trim()) {
        contentParts.push(name.trim());
      }
    }
  }

  return contentParts.join("|");
}

/**
 * Compute structural DOM hash that ignores text content changes
 *
 * Use this hash for cache keys when you want cache hits even if
 * page text changes (timestamps, counters, etc.) but structure stays the same.
 *
 * @param page - Playwright page for URL and viewport
 * @param domState - Full accessibility tree string
 * @returns StructuralHashResult with structural, content, and full hashes
 */
export async function computeStructuralDomHash(
  page: Page,
  domState: string
): Promise<StructuralHashResult | null> {
  if (!domState || !domState.trim()) {
    return null;
  }

  try {
    let viewport = page.viewportSize();
    if (!viewport) {
      viewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));
    }

    const viewportLabel = viewport
      ? `${viewport.width}x${viewport.height}`
      : "unknown-viewport";

    const url = page.url();
    const structure = extractStructure(domState);
    const content = extractContent(domState);

    // Structural hash - ignores text content
    const structuralPayload = `${url}::${viewportLabel}::${structure}`;
    const structuralHash = sha256(structuralPayload);

    // Content hash - just the text
    const contentHash = sha256(content);

    // Full hash - matches legacy behavior
    const fullPayload = `${url}::${viewportLabel}::${domState}`;
    const fullHash = sha256(fullPayload);

    return {
      structuralHash,
      contentHash,
      fullHash,
    };
  } catch {
    return null;
  }
}
