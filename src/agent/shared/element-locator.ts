/**
 * Shared utility for getting Playwright locators from encoded element IDs
 * Extracted from HyperAgent for reusability across aiAction and agent actions
 */

import type { Page } from "playwright-core";
import { toEncodedId, type IframeInfo, resolveFrameByXPath } from "../../context-providers/a11y-dom";
import { HyperagentError } from "../error";

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
  // Convert elementId to EncodedId format for xpath lookup
  const encodedId = toEncodedId(elementId);
  const rawXpath = xpathMap[encodedId];

  if (!rawXpath) {
    const errorMsg = `Element ${elementId} not found in xpath map`;
    if (debug) {
      console.error(`[getElementLocator] ${errorMsg}`);
      console.error(
        `[getElementLocator] Looking for element with ID: ${elementId} (type: ${typeof elementId})`
      );
      console.error(
        `[getElementLocator] Direct lookup result:`,
        xpathMap[encodedId]
      );
    }
    throw new HyperagentError(errorMsg, 404);
  }

  // Trim trailing text nodes from xpath
  const xpath = rawXpath.replace(/\/text\(\)(\[\d+\])?$/iu, "");

  // Extract frameIndex from encodedId (format: "frameIndex-nodeIndex")
  const [frameIndexStr] = encodedId.split("-");
  const frameIndex = parseInt(frameIndexStr!, 10);

  // Main frame (frameIndex 0) - use page.locator()
  if (frameIndex === 0) {
    return { locator: page.locator(`xpath=${xpath}`), xpath };
  }

  if (!frameMap || !frameMap.has(frameIndex)) {
    const errorMsg = `Frame metadata not found for frame ${frameIndex}`;
    if (debug) {
      console.error(`[getElementLocator] ${errorMsg}`);
    }
    throw new HyperagentError(errorMsg, 404);
  }

  const iframeInfo = frameMap.get(frameIndex)!;

  if (debug) {
    console.log(
      `[getElementLocator] Resolving frame ${frameIndex} via XPath/URL metadata`
    );
  }
  const targetFrame =
    (await resolveFrameByXPath(page, frameMap, frameIndex)) ?? undefined;

  if (!targetFrame) {
    const errorMsg = `Could not resolve frame for element ${elementId} (frameIndex: ${frameIndex})`;
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
        page.frames().map((f) => ({ url: f.url(), name: f.name() }))
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
      `[getElementLocator] Using frame ${frameIndex} locator for element ${elementId}`
    );
    console.log(
      `[getElementLocator] Frame URL: ${targetFrame.url()}, Name: ${targetFrame.name()}`
    );
  }

  return { locator: targetFrame.locator(`xpath=${xpath}`), xpath };
}
