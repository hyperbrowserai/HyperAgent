export const getXPath = (element: HTMLElement) => {
  const segments = [];
  let currentElement: HTMLElement | null = element;

  while (currentElement && currentElement.nodeType === Node.ELEMENT_NODE) {
    if (
      currentElement.parentNode instanceof ShadowRoot ||
      currentElement.parentNode instanceof HTMLIFrameElement
    ) {
      break;
    }

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

    // Always include position index if there are siblings with the same tag name
    // This ensures uniqueness of the XPath
    const xpathIndex = hasSiblings ? `[${index + 1}]` : "";

    // Add id attribute for even more uniqueness if present
    if (currentElement.id && currentElement.id.toString().trim() !== "") {
      segments.unshift(`${tagName}[@id="${currentElement.id}"]`);
    } else {
      segments.unshift(`${tagName}${xpathIndex}`);
    }

    currentElement = currentElement.parentElement;
  }

  return segments.join("/");
};
