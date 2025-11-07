/**
 * Renders visual overlay with numbered/labeled bounding boxes
 * Labels use encodedId format (e.g., "0-1234", "2-5678")
 */

import { Jimp, loadFont } from "jimp";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SANS_16_WHITE } = require("jimp/fonts");

import type { DOMRect, EncodedId } from "./types";
import { getHighlightColorRgba } from "../shared/highlight-colors";

export interface OverlayOptions {
  width: number;
  height: number;
  showEncodedIds?: boolean; // Show full encodedId vs just index
  colorScheme?: "red" | "rainbow";
}

type JimpInstance = InstanceType<typeof Jimp>;

/**
 * Draw a rectangle outline on the image
 */
function drawRect(
  image: JimpInstance,
  x: number,
  y: number,
  width: number,
  height: number,
  color: number,
  lineWidth = 2
): void {
  // Ensure coordinates are integers and within bounds
  x = Math.max(0, Math.round(x));
  y = Math.max(0, Math.round(y));
  width = Math.round(width);
  height = Math.round(height);

  const imgWidth = image.bitmap.width;
  const imgHeight = image.bitmap.height;

  // Draw top and bottom lines
  for (let i = 0; i < lineWidth; i++) {
    for (let dx = 0; dx < width; dx++) {
      const px = x + dx;
      // Top line
      if (px < imgWidth && y + i < imgHeight) {
        image.setPixelColor(color, px, y + i);
      }
      // Bottom line
      if (
        px < imgWidth &&
        y + height - i - 1 >= 0 &&
        y + height - i - 1 < imgHeight
      ) {
        image.setPixelColor(color, px, y + height - i - 1);
      }
    }
  }

  // Draw left and right lines
  for (let i = 0; i < lineWidth; i++) {
    for (let dy = 0; dy < height; dy++) {
      const py = y + dy;
      // Left line
      if (x + i < imgWidth && py < imgHeight) {
        image.setPixelColor(color, x + i, py);
      }
      // Right line
      if (
        x + width - i - 1 >= 0 &&
        x + width - i - 1 < imgWidth &&
        py < imgHeight
      ) {
        image.setPixelColor(color, x + width - i - 1, py);
      }
    }
  }
}

/**
 * Draw a filled rectangle on the image
 */
function fillRect(
  image: JimpInstance,
  x: number,
  y: number,
  width: number,
  height: number,
  color: number
): void {
  // Ensure coordinates are integers
  x = Math.max(0, Math.round(x));
  y = Math.max(0, Math.round(y));
  width = Math.round(width);
  height = Math.round(height);

  const imgWidth = image.bitmap.width;
  const imgHeight = image.bitmap.height;

  for (let dx = 0; dx < width; dx++) {
    for (let dy = 0; dy < height; dy++) {
      const px = x + dx;
      const py = y + dy;
      if (px < imgWidth && py < imgHeight) {
        image.setPixelColor(color, px, py);
      }
    }
  }
}

/**
 * Render a11y tree elements as visual overlay
 *
 * @param boundingBoxMap - Map of encodedId to bounding boxes
 * @param options - Rendering options
 * @returns Base64-encoded PNG image
 */
export async function renderA11yOverlay(
  boundingBoxMap: Map<EncodedId, DOMRect>,
  options: OverlayOptions
): Promise<string> {
  const {
    width,
    height,
    showEncodedIds = true,
    colorScheme = "rainbow",
  } = options;

  // Create transparent image
  const image = new Jimp({ width, height, color: 0x00000000 });

  // Load font for labels
  const font = await loadFont(SANS_16_WHITE);

  // Draw each element
  let index = 0;
  for (const [encodedId, rect] of boundingBoxMap.entries()) {
    // Skip if not visible
    if (rect.width <= 0 || rect.height <= 0) continue;

    const color = getHighlightColorRgba(index, colorScheme);

    // Draw bounding box outline
    drawRect(image, rect.x, rect.y, rect.width, rect.height, color, 2);

    // Draw label
    const label = showEncodedIds ? encodedId : `${index + 1}`;

    // Estimate label dimensions (approximate)
    const labelWidth = label.length * 9 + 8; // ~9px per char + padding
    const labelHeight = 20;

    // Label background position (above the element if possible)
    const labelX = Math.max(0, Math.round(rect.x));
    const labelY = Math.max(0, Math.round(rect.y - labelHeight));

    // Draw label background
    fillRect(image, labelX, labelY, labelWidth, labelHeight, color);

    // Draw label text
    image.print({ font, x: labelX + 4, y: labelY + 2, text: label });

    index++;
  }

  // Convert to base64 PNG
  const buffer = await image.getBuffer("image/png");
  return buffer.toString("base64");
}
