// --- Interfaces ---

interface HighlightInfo {
  element: HTMLElement;
  index: number;
  parentIframe: HTMLElement | null;
}

interface IframeOffset {
  x: number;
  y: number;
}

// --- Helper Functions (Stateless) ---

const isElementPartiallyVisible = (rect: DOMRect): boolean => {
  // Check if the element is within the viewport, considering potential zero dimensions
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.top < window.innerHeight && // These checks are relative to the current viewport
    rect.bottom > 0 && // where the rect was calculated.
    rect.left < window.innerWidth &&
    rect.right > 0
  );
};

const getHighlightColor = (
  index: number,
): { baseColor: string; backgroundColor: string } => {
  const colors = [
    "#FF0000",
    "#00FF00",
    "#0000FF",
    "#FFA500",
    "#800080",
    "#008080",
    "#FF69B4",
    "#4B0082",
    "#FF4500",
    "#2E8B57",
    "#DC143C",
    "#4682B4",
  ];
  const colorIndex = index % colors.length;
  const baseColor = colors[colorIndex];
  const backgroundColor = baseColor + "1A";
  return { baseColor, backgroundColor };
};

// Calculates label position relative to the canvas (0,0 top-left)
const calculateLabelPosition = (
  rect: DOMRect,
  iframeOffset: IframeOffset,
  labelWidth: number,
  labelHeight: number,
  canvasWidth: number, // Pass canvas dims for bounds checking
  canvasHeight: number,
): { top: number; left: number } => {
  const top = rect.top + iframeOffset.y;
  const left = rect.left + iframeOffset.x;

  // Default: top-right corner relative to element
  let labelTop = top - labelHeight;
  let labelLeft = left + rect.width - labelWidth;

  // Constraints to keep label within *canvas* bounds
  labelTop = Math.min(labelTop, canvasHeight - labelHeight);
  labelLeft = Math.min(labelLeft, canvasWidth - labelWidth);

  // Basic overlap check (can be improved) - position relative to element
  const elementBottom = top + rect.height;
  const elementRight = left + rect.width;

  // If the calculated top-left of the label is inside the element's box
  if (
    labelTop + labelHeight > top &&
    labelTop < elementBottom &&
    labelLeft + labelWidth > left &&
    labelLeft < elementRight
  ) {
    // Try bottom-right corner relative to element
    labelTop = elementBottom;
    labelLeft = elementRight - labelWidth;

    // Re-apply constraints
    labelTop = Math.min(labelTop, canvasHeight - labelHeight);
    labelLeft = Math.min(labelLeft, canvasWidth - labelWidth);
  }

  return { top: labelTop, left: labelLeft };
};

// --- Public API ---

/**
 * Renders highlights for the given elements onto an OffscreenCanvas
 * and returns an ImageBitmap.
 *
 * @param highlightInfos Array of objects describing elements to highlight.
 * @param width The desired width of the canvas (e.g., window.innerWidth).
 * @param height The desired height of the canvas (e.g., window.innerHeight).
 * @returns A Promise resolving to an ImageBitmap containing the highlights.
 */
export function renderHighlightsOffscreen(
  highlightInfos: HighlightInfo[],
  width: number,
  height: number,
): ImageBitmap {
  if (width <= 0 || height <= 0) {
    console.warn(
      "Attempted to render highlights on zero-sized canvas. Will default to innerWidth x innerHeight",
    );
    // Return an empty bitmap maybe? Or null.
    const emptyCanvas = new OffscreenCanvas(
      window.innerWidth,
      window.innerHeight,
    );
    return emptyCanvas.transferToImageBitmap();
  }

  const dpr = window.devicePixelRatio || 1;
  const canvasWidth = width * dpr;
  const canvasHeight = height * dpr;
  const offscreenCanvas = new OffscreenCanvas(canvasWidth, canvasHeight);
  const ctx = offscreenCanvas.getContext("2d", {
    alpha: true,
  }) as OffscreenCanvasRenderingContext2D; // Ensure alpha for transparency

  // Scale context for DPI awareness. All drawing coords should be in logical pixels.
  ctx.scale(dpr, dpr);

  // Clear canvas (important for transparency)
  ctx.clearRect(0, 0, width, height);

  try {
    highlightInfos.forEach(({ element, index, parentIframe }) => {
      // Element might be stale, ensure it's still in the DOM
      if (!document.body.contains(element)) {
        return; // Skip elements not in DOM
      }

      const rect = element.getBoundingClientRect();
      // Skip elements that are not visible or have no dimensions
      if (
        !rect ||
        rect.width === 0 ||
        rect.height === 0 ||
        !isElementPartiallyVisible(rect)
      ) {
        return;
      }

      const iframeOffset: IframeOffset = { x: 0, y: 0 };
      if (parentIframe && document.body.contains(parentIframe)) {
        const iframeRect = parentIframe.getBoundingClientRect();
        iframeOffset.x = iframeRect.left;
        iframeOffset.y = iframeRect.top;
      }

      const colors = getHighlightColor(index);
      const drawTop = rect.top + iframeOffset.y;
      const drawLeft = rect.left + iframeOffset.x;

      // --- Draw overlay rectangle ---
      ctx.fillStyle = colors.backgroundColor;
      ctx.fillRect(drawLeft, drawTop, rect.width, rect.height);
      ctx.strokeStyle = colors.baseColor;
      ctx.lineWidth = 1; // Use 1 logical pixel for crispness after scaling
      ctx.strokeRect(drawLeft, drawTop, rect.width, rect.height);

      // --- Draw label ---
      const labelText = index.toString();
      // Font size calculation needs to consider DPR if you want physical pixel size
      // Or keep it simple with logical pixels. Let's use logical pixels.
      const fontSize = Math.min(12, Math.max(9, rect.height * 0.3));
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      // Estimate label dimensions in logical pixels
      const textMetrics = ctx.measureText(labelText);
      const labelPadding = 4;
      const labelHeight = fontSize + labelPadding;
      // Ensure width is at least height for near-square background
      const labelWidth = Math.max(
        labelHeight,
        textMetrics.width + labelPadding * 2,
      );

      // Calculate position relative to the canvas (using logical pixels)
      const labelPos = calculateLabelPosition(
        rect,
        iframeOffset,
        labelWidth,
        labelHeight,
        width,
        height,
      );

      // Draw label background (logical pixels)
      ctx.fillStyle = colors.baseColor;
      ctx.fillRect(labelPos.left, labelPos.top, labelWidth, labelHeight);

      // Draw label text (logical pixels)
      ctx.fillStyle = "white";
      ctx.fillText(
        labelText,
        labelPos.left + labelWidth / 2,
        labelPos.top + labelHeight / 2,
      );
    });

    // Transfer the bitmap
    return offscreenCanvas.transferToImageBitmap();
  } catch (error) {
    console.error("Error drawing highlights onto OffscreenCanvas:", error);
    // In case of error, maybe return an empty bitmap or null
    const emptyCanvas = new OffscreenCanvas(1, 1);
    return emptyCanvas.transferToImageBitmap(); // Or return null
  }
}
