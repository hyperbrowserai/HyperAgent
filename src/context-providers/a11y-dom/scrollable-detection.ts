/**
 * Scrollable element detection utilities
 * Detects elements with overflow scrolling for enhanced accessibility tree
 */

import type { Page, Frame } from 'playwright-core';
import type { CDPSession } from '@/cdp';

/**
 * Browser-side functions to detect scrollable elements
 * These will be injected into the page context
 */
export const scrollableDetectionScript = `
/**
 * Tests if an element can actually scroll
 * by attempting a scroll and checking if scrollTop changes
 */
function canElementScroll(elem) {
  if (typeof elem.scrollTo !== 'function') {
    return false;
  }

  try {
    const originalTop = elem.scrollTop;

    // Try to scroll
    elem.scrollTo({
      top: originalTop + 100,
      left: 0,
      behavior: 'instant',
    });

    // If scrollTop never changed, it's not scrollable
    if (elem.scrollTop === originalTop) {
      return false;
    }

    // Scroll back to original position
    elem.scrollTo({
      top: originalTop,
      left: 0,
      behavior: 'instant',
    });

    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Finds and returns a list of scrollable elements on the page,
 * ordered from the element with the largest scrollHeight to the smallest.
 *
 * @param topN Optional maximum number of scrollable elements to return
 * @returns Array of scrollable HTMLElements sorted by descending scrollHeight
 */
function getScrollableElements(topN) {
  // Get the root <html> element
  const docEl = document.documentElement;

  // Initialize array to hold all scrollable elements
  // Always include the root <html> element as a fallback
  const scrollableElements = [docEl];

  // Scan all elements to find potential scrollable containers
  const allElements = document.querySelectorAll('*');
  for (const elem of allElements) {
    const style = window.getComputedStyle(elem);
    const overflowY = style.overflowY;

    const isPotentiallyScrollable =
      overflowY === 'auto' ||
      overflowY === 'scroll' ||
      overflowY === 'overlay';

    if (isPotentiallyScrollable) {
      const candidateScrollDiff = elem.scrollHeight - elem.clientHeight;
      // Only consider if it has extra scrollable content and can truly scroll
      if (candidateScrollDiff > 0 && canElementScroll(elem)) {
        scrollableElements.push(elem);
      }
    }
  }

  // Sort scrollable elements from largest scrollHeight to smallest
  scrollableElements.sort((a, b) => b.scrollHeight - a.scrollHeight);

  // If a topN limit is specified, return only the first topN elements
  if (topN !== undefined) {
    return scrollableElements.slice(0, topN);
  }

  // Return all found scrollable elements
  return scrollableElements;
}

/**
 * Generate XPath for an element
 */
function generateXPathForElement(element) {
  if (element.id && element.id.toString().trim() !== '') {
    return \`//\${element.tagName.toLowerCase()}[@id="\${element.id}"]\`;
  }

  const segments = [];
  let currentElement = element;

  while (currentElement && currentElement.nodeType === Node.ELEMENT_NODE) {
    let index = 0;
    let hasSiblings = false;
    let sibling = currentElement.previousSibling;

    while (sibling) {
      if (
        sibling.nodeType === Node.ELEMENT_NODE &&
        sibling.nodeName === currentElement.nodeName
      ) {
        index++;
        hasSiblings = true;
      }
      sibling = sibling.previousSibling;
    }

    if (!hasSiblings) {
      sibling = currentElement.nextSibling;
      while (sibling) {
        if (
          sibling.nodeType === Node.ELEMENT_NODE &&
          sibling.nodeName === currentElement.nodeName
        ) {
          hasSiblings = true;
          break;
        }
        sibling = sibling.nextSibling;
      }
    }

    const tagName = currentElement.nodeName.toLowerCase();
    const xpathIndex = hasSiblings ? \`[\${index + 1}]\` : '';
    segments.unshift(\`\${tagName}\${xpathIndex}\`);

    currentElement = currentElement.parentElement;
  }

  return '/' + segments.join('/');
}

/**
 * Get XPaths for all scrollable elements
 */
function getScrollableElementXpaths(topN) {
  const scrollableElems = getScrollableElements(topN);
  const xpaths = [];
  for (const elem of scrollableElems) {
    const xpath = generateXPathForElement(elem);
    xpaths.push(xpath);
  }
  return xpaths;
}

// Expose to window for CDP evaluation
window.__hyperagent_getScrollableElementXpaths = getScrollableElementXpaths;
`;

/**
 * Inject scrollable detection functions into the page context
 */
export async function injectScrollableDetection(page: Page): Promise<void> {
  await page.evaluate(scrollableDetectionScript);
}

/**
 * Get XPaths of scrollable elements from the page or frame
 */
export async function getScrollableElementXpaths(
  pageOrFrame: Page | Frame,
  topN?: number
): Promise<string[]> {
  try {
    const xpaths = await pageOrFrame.evaluate((n) => {
      // @ts-ignore - function injected via script
      return window.__hyperagent_getScrollableElementXpaths?.(n) ?? [];
    }, topN);
    return xpaths;
  } catch (error) {
    console.warn('Error getting scrollable element xpaths:', error);
    return [];
  }
}

/**
 * Find backend node IDs for scrollable elements
 * This is called during accessibility tree extraction to mark scrollable elements
 */
export async function findScrollableElementIds(
  pageOrFrame: Page | Frame,
  client: CDPSession
): Promise<Set<number>> {
  try {
    // Get XPaths of scrollable elements
    const xpaths = await getScrollableElementXpaths(pageOrFrame);

    const backendIds = new Set<number>();

    // Resolve each XPath to a backend node ID
    for (const xpath of xpaths) {
      if (!xpath) continue;

      try {
        // Evaluate XPath to get object ID
        const { result } = (await client.send('Runtime.evaluate', {
          expression: `
            (function() {
              const result = document.evaluate(
                ${JSON.stringify(xpath)},
                document.documentElement,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null
              );
              return result.singleNodeValue;
            })()
          `,
          returnByValue: false,
        })) as { result: { objectId?: string } };

        if (result.objectId) {
          // Get backend node ID from object ID
          const { node } = (await client.send('DOM.describeNode', {
            objectId: result.objectId,
          })) as { node: { backendNodeId?: number } };

          if (node?.backendNodeId) {
            backendIds.add(node.backendNodeId);
          }
        }
      } catch (error) {
        // Silently ignore errors for individual elements
        console.warn(`Error resolving XPath ${xpath}:`, error);
      }
    }

    return backendIds;
  } catch (error) {
    console.error('Error finding scrollable element IDs:', error);
    return new Set();
  }
}

/**
 * Decorate a role string with "scrollable" prefix if the element is scrollable
 */
export function decorateRoleIfScrollable(
  role: string,
  backendNodeId: number | undefined,
  scrollableIds: Set<number>
): string {
  if (backendNodeId !== undefined && scrollableIds.has(backendNodeId)) {
    // Prepend "scrollable" to the role
    if (role && role !== 'generic' && role !== 'none') {
      return `scrollable, ${role}`;
    }
    return 'scrollable';
  }
  return role;
}
