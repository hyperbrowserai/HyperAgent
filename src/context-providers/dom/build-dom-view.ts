import { findInteractiveElements } from "./find-interactive-elements";
import { renderHighlightsOffscreen } from "./highlight";
import { getXPath } from "./get-x-path";
import { CONTEXT_ATTRIBUTES } from "./const";
import { DOMStateRaw } from "./types";

// Helper function to convert ImageBitmap to PNG Data URL
const imageBitmapToPngDataUrl = (bitmap: ImageBitmap): string => {
  try {
    // Create an intermediate canvas
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;

    // Get context and draw the bitmap
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    ctx.drawImage(bitmap, 0, 0);

    // Export as PNG Data URL
    // Note: might want to add error handling for toDataURL
    return canvas.toDataURL("image/png");
  } finally {
    // Close the bitmap to free up resources (important!)
    bitmap.close();
  }
};

export const buildDomView = (): DOMStateRaw => {
  const interactiveElements = findInteractiveElements();

  // 1. Render highlights to an ImageBitmap
  const screenBitmap = renderHighlightsOffscreen(
    interactiveElements.map((element, index) => ({
      element: element.element,
      index: index + 1, // index range from 1 -> index
      parentIframe: element.iframe ?? null,
    })),
    window.innerWidth,
    window.innerHeight
  );

  // 2. Convert the ImageBitmap to a PNG Data URL
  const screenshotPngDataUrl = imageBitmapToPngDataUrl(screenBitmap);

  for (let idx = 0; idx < interactiveElements.length; idx++) {
    const element = interactiveElements[idx];
    element.highlightIndex = idx + 1; // index range from 1 -> index
    element.xPath = getXPath(element.element);
  }

  const domRepresentation: string[] = [];

  const getTextBetween = (node: Node, nextNode: Node | null): string => {
    const texts: string[] = [];
    let current = node.nextSibling;

    while (current && current !== nextNode) {
      if (current.nodeType === Node.TEXT_NODE && current.textContent) {
        const text = current.textContent.trim();
        if (text) texts.push(text);
      }
      current = current.nextSibling;
    }

    return texts.join(" ");
  };

  for (let i = 0; i < interactiveElements.length; i++) {
    const element = interactiveElements[i];
    const el = element.element;
    const tagName = el.tagName.toLowerCase();

    let attributes = "";
    Array.from(el.attributes).forEach((attr) => {
      if (CONTEXT_ATTRIBUTES.includes(attr.name)) {
        attributes += ` ${attr.name}="${attr.value}"`;
      }
    });

    const textContent = el.textContent?.trim() || "";
    const indexPrefix = `[${element.highlightIndex}]`;
    const elementString = `${indexPrefix}<${tagName}${attributes}>${textContent.replace(/\s+/g, " ")}</${tagName}>`;
    domRepresentation.push(elementString);

    const nextElement = interactiveElements[i + 1]?.element || null;
    const betweenText = getTextBetween(el, nextElement);
    if (betweenText) {
      domRepresentation.push(betweenText);
    }
  }

  return {
    elements: interactiveElements,
    domState: domRepresentation.join("\n"),
    screenshot: screenshotPngDataUrl,
  };
};
