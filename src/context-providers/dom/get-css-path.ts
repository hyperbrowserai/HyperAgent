/**
 * Escapes characters that have special meaning in CSS selectors.
 * Handles common cases like IDs and class names.
 *
 * @param value The string to escape (e.g., an ID or class name).
 * @returns The escaped string suitable for use in a CSS selector.
 */
const escapeSelector = (value: string): string => {
  return CSS.escape(value);
};

/**
 * Generates a unique CSS selector segment for a given element relative to its siblings.
 * Prefers ID, then unique classes, then :nth-of-type.
 *
 * @param element The element to generate the selector for.
 * @returns A CSS selector segment string (e.g., "div#myId", "button.btn.primary", "span:nth-of-type(2)").
 */
const getUniqueSegment = (element: HTMLElement): string => {
  const tagName = element.tagName.toLowerCase();
  const parent = element.parentElement;

  // 1. Try ID
  if (element.id) {
    const idSelector = `#${escapeSelector(element.id)}`;
    return idSelector;
  }

  // 2. Try unique combination of classes
  const classes = Array.from(element.classList).map(escapeSelector).join(".");
  if (classes && parent) {
    const classSelector = `${tagName}.${classes}`;
    const siblingsWithSameClasses = Array.from(
      parent.querySelectorAll(`:scope > ${classSelector}`),
    );
    if (
      siblingsWithSameClasses.length === 1 &&
      siblingsWithSameClasses[0] === element
    ) {
      return classSelector;
    }
  }

  // 3. Fallback to :nth-of-type
  let index = 1; // CSS :nth-of-type is 1-based
  let sibling = element.previousElementSibling;
  while (sibling) {
    if (sibling.tagName === element.tagName) {
      index++;
    }
    sibling = sibling.previousElementSibling;
  }

  // Only add :nth-of-type if there are other siblings of the same type
  let hasSameTypeSiblings = index > 1; // Already found preceding siblings
  if (!hasSameTypeSiblings && parent) {
    sibling = element.nextElementSibling;
    while (sibling) {
      if (sibling.tagName === element.tagName) {
        hasSameTypeSiblings = true;
        break;
      }
      sibling = sibling.nextElementSibling;
    }
  }

  return hasSameTypeSiblings ? `${tagName}:nth-of-type(${index})` : tagName;
};

/**
 * Calculates a CSS selector path for an element relative to a boundary node (Document or ShadowRoot).
 * Uses '>' as the child combinator.
 *
 * @param element The target element.
 * @param boundary The node (Document or ShadowRoot) to stop traversal at.
 * @returns A relative CSS selector string.
 */
const getRelativeCSSPath = (element: HTMLElement, boundary: Node): string => {
  if (element === boundary) {
    return ""; // Should not happen if called correctly, but return empty if it does
  }

  const segments: string[] = [];
  let currentElement: HTMLElement | null = element;

  while (
    currentElement &&
    currentElement !== boundary &&
    currentElement.nodeType === Node.ELEMENT_NODE
  ) {
    const segment = getUniqueSegment(currentElement);
    segments.unshift(segment);

    const parent = currentElement.parentElement;
    // Stop if parent is null, not an element, or the boundary itself
    if (
      !parent ||
      parent === boundary ||
      parent.nodeType !== Node.ELEMENT_NODE
    ) {
      break;
    }
    currentElement = parent as HTMLElement;
  }

  return segments.join(" > ");
};

/**
 * Generates a full CSS selector path for a given element, handling shadow DOM boundaries.
 * Uses Playwright's '>>' syntax to denote shadow DOM transitions.
 *
 * @param element The target HTMLElement.
 * @returns A CSS selector string that can be used with Playwright locators.
 */
export const getCSSPath = (element: HTMLElement | null): string => {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    // console.warn("getCSSPath called with invalid element:", element);
    return "";
  }

  if (!element.isConnected) {
    // console.warn("getCSSPath called with disconnected element:", element);
    // Attempting to generate path anyway, might be useful in some rare debugging cases
  }

  const root = element.getRootNode();

  if (root instanceof ShadowRoot) {
    // Element is inside a shadow DOM
    const host = root.host as HTMLElement;
    if (!host) {
      console.warn("ShadowRoot found without a host element:", root);
      // Cannot generate a path from the document root if the host is unknown
      return ""; // Or potentially just the relative path within the shadow root? Unreliable.
    }
    const hostPath = getCSSPath(host); // Recursive call to get path to the host
    const relativePath = getRelativeCSSPath(element, root); // Path within the shadow root

    if (!hostPath) {
      console.warn("Could not determine CSS path for host element:", host);
      return ""; // Cannot construct full path
    }
    if (!relativePath) {
      console.warn(
        "Could not determine relative CSS path within ShadowRoot for:",
        element,
      );
      // Element might be the direct child/root of the shadow DOM, or path generation failed.
      // Playwright needs a selector after >>, maybe ':host' or '*' or just return hostPath?
      // Returning just hostPath might select the host instead of the shadow content.
      // Let's assume relativePath should usually exist. If not, path is likely invalid.
      return "";
    }

    // Playwright syntax for piercing shadow DOM
    return `${hostPath} >> ${relativePath}`;
  } else if (root instanceof Document) {
    // Element is in the main document or an iframe document
    return getRelativeCSSPath(element, root);
  } else {
    console.warn(
      "Element root is neither Document nor ShadowRoot:",
      root,
      "for element:",
      element,
    );
    // Fallback: Try to compute path relative to its own root node anyway
    return getRelativeCSSPath(element, root);
  }
};
