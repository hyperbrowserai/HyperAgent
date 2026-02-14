/**
 * Shared utility for getting Playwright locators from encoded element IDs
 * Extracted from HyperAgent for reusability across page.perform and agent actions
 */

import type { Page } from "playwright-core";
import {
  toEncodedId,
  type IframeInfo,
  resolveFrameByXPath,
} from "../../context-providers/a11y-dom";
import { HyperagentError } from "../error";
import { formatUnknownError } from "@/utils";

const MAX_ELEMENT_LOCATOR_DIAGNOSTIC_CHARS = 400;
const MAX_ELEMENT_LOCATOR_IDENTIFIER_CHARS = 128;

function sanitizeElementLocatorText(value: string): string {
  if (value.length === 0) {
    return value;
  }
  const withoutControlChars = Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code < 32) || code === 127 ? " " : char;
  }).join("");
  return withoutControlChars.replace(/\s+/g, " ").trim();
}

function truncateElementLocatorText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}... [truncated ${omitted} chars]`;
}

function formatElementLocatorDiagnostic(value: unknown): string {
  const normalized = sanitizeElementLocatorText(formatUnknownError(value));
  const fallback = normalized.length > 0 ? normalized : "unknown error";
  return truncateElementLocatorText(
    fallback,
    MAX_ELEMENT_LOCATOR_DIAGNOSTIC_CHARS
  );
}

function formatElementLocatorIdentifier(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = sanitizeElementLocatorText(value);
  if (normalized.length === 0) {
    return fallback;
  }
  return truncateElementLocatorText(
    normalized,
    MAX_ELEMENT_LOCATOR_IDENTIFIER_CHARS
  );
}

/**
 * Get a Playwright locator for an element by its encoded ID
 *
 * Handles both main frame (frameIndex 0) and iframe elements.
 * Iframes are resolved lazily using their XPath path / URL metadata.
 *
 * @param elementId - Element ID (will be converted to EncodedId format)
 * @param xpathMap - Map of encodedId to xpath strings
 * @param page - Playwright page
 * @param frameMap - Optional map of frame indices to IframeInfo
 * @param debug - Enable debug logging
 * @returns Playwright locator and trimmed xpath
 */
export async function getElementLocator(
  elementId: string,
  xpathMap: Record<string, string>,
  page: Page,
  frameMap?: Map<number, IframeInfo>,
  debug = false
): Promise<{ locator: ReturnType<Page["locator"]>; xpath: string }> {
  const normalizedElementId =
    typeof elementId === "string" ? elementId.trim() : "";
  if (normalizedElementId.length === 0) {
    throw new HyperagentError("Element ID must be a non-empty string", 400);
  }
  const safeElementId = formatElementLocatorIdentifier(
    normalizedElementId,
    "unknown-element"
  );

  // Convert elementId to EncodedId format for xpath lookup
  let encodedId: string;
  try {
    encodedId = toEncodedId(normalizedElementId);
  } catch (error) {
    throw new HyperagentError(
      `Failed to normalize element ID "${safeElementId}": ${formatElementLocatorDiagnostic(
        error
      )}`,
      400
    );
  }
  let rawXpath: unknown;
  try {
    rawXpath = xpathMap[encodedId];
  } catch (error) {
    throw new HyperagentError(
      `Element lookup failed for ${safeElementId}: ${formatElementLocatorDiagnostic(
        error
      )}`,
      500
    );
  }

  if (typeof rawXpath !== "string" || rawXpath.trim().length === 0) {
    const errorMsg = `Element ${safeElementId} not found in xpath map`;
    if (debug) {
      console.error(`[getElementLocator] ${errorMsg}`);
      console.error(
        `[getElementLocator] Looking for element with ID: ${normalizedElementId} (type: ${typeof normalizedElementId})`
      );
      console.error(
        `[getElementLocator] Direct lookup result:`,
        xpathMap[encodedId]
      );
    }
    throw new HyperagentError(errorMsg, 404);
  }

  // Trim trailing text nodes from xpath
  const xpath = rawXpath
    .trim()
    .replace(/\/text\(\)(\[\d+\])?$/iu, "")
    .trim();

  // Extract frameIndex from encodedId (format: "frameIndex-nodeIndex")
  const [frameIndexStr] = encodedId.split("-");
  const frameIndex = parseInt(frameIndexStr!, 10);
  if (!Number.isFinite(frameIndex) || frameIndex < 0) {
    const safeEncodedId = formatElementLocatorIdentifier(
      encodedId,
      "unknown-encoded-id"
    );
    throw new HyperagentError(
      `Invalid frame index in encoded element ID "${safeEncodedId}"`,
      400
    );
  }

  // Main frame (frameIndex 0) - use page.locator()
  if (frameIndex === 0) {
    return { locator: page.locator(`xpath=${xpath}`), xpath };
  }

  let hasFrameMetadata = false;
  try {
    hasFrameMetadata = Boolean(frameMap?.has(frameIndex));
  } catch (error) {
    throw new HyperagentError(
      `Frame metadata lookup failed for frame ${frameIndex}: ${formatElementLocatorDiagnostic(
        error
      )}`,
      500
    );
  }

  if (!frameMap || !hasFrameMetadata) {
    const errorMsg = `Frame metadata not found for frame ${frameIndex}`;
    if (debug) {
      console.error(`[getElementLocator] ${errorMsg}`);
    }
    throw new HyperagentError(errorMsg, 404);
  }

  let iframeInfo: IframeInfo | undefined;
  try {
    iframeInfo = frameMap.get(frameIndex) ?? undefined;
  } catch (error) {
    throw new HyperagentError(
      `Frame metadata retrieval failed for frame ${frameIndex}: ${formatElementLocatorDiagnostic(
        error
      )}`,
      500
    );
  }
  if (!iframeInfo) {
    throw new HyperagentError(
      `Frame metadata not found for frame ${frameIndex}`,
      404
    );
  }

  if (debug) {
    console.log(
      `[getElementLocator] Resolving frame ${frameIndex} via XPath/URL metadata`
    );
  }
  let targetFrame:
    | Awaited<ReturnType<typeof resolveFrameByXPath>>
    | undefined;
  try {
    targetFrame = (await resolveFrameByXPath(page, frameMap, frameIndex)) ?? undefined;
  } catch (error) {
    throw new HyperagentError(
      `Could not resolve frame for element ${safeElementId} (frameIndex: ${frameIndex}): ${formatElementLocatorDiagnostic(
        error
      )}`,
      500
    );
  }

  if (!targetFrame) {
    const errorMsg = `Could not resolve frame for element ${safeElementId} (frameIndex: ${frameIndex})`;
    if (debug) {
      console.error(`[getElementLocator] ${errorMsg}`);
      console.error(`[getElementLocator] Frame info:`, {
        src: iframeInfo.src,
        name: iframeInfo.name,
        xpath: iframeInfo.xpath,
        parentFrameIndex: iframeInfo.parentFrameIndex,
      });
      console.error(
        `[getElementLocator] Available frames:`,
        page
          .frames()
          .map((f) => ({ url: f.url(), name: f.name() }))
      );
    }
    throw new HyperagentError(errorMsg, 404);
  }

  if (debug) {
    console.log(
      `[getElementLocator] Using Playwright Frame ${frameIndex}: ${targetFrame.url()}`
    );
  }

  // Wait for iframe content to be loaded
  try {
    await targetFrame.waitForLoadState("domcontentloaded", { timeout: 5000 });
  } catch {
    if (debug) {
      console.warn(
        `[getElementLocator] Timeout waiting for iframe to load (frame ${frameIndex}), proceeding anyway`
      );
    }
    // Continue anyway - frame might already be loaded
  }

  if (debug) {
    console.log(
      `[getElementLocator] Using frame ${frameIndex} locator for element ${normalizedElementId}`
    );
    console.log(
      `[getElementLocator] Frame URL: ${targetFrame.url()}, Name: ${targetFrame.name()}`
    );
  }

  return { locator: targetFrame.locator(`xpath=${xpath}`), xpath };
}
