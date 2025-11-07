/**
 * Shared color palette for element highlighting across DOM and A11y modes
 */

import { rgbaToInt } from "jimp";

/**
 * Rainbow color palette (12 colors)
 * Used for cycling through element highlights
 */
export const HIGHLIGHT_COLORS = [
  "#FF0000", // red
  "#00FF00", // green
  "#0000FF", // blue
  "#FFA500", // orange
  "#800080", // purple
  "#008080", // teal
  "#FF69B4", // hot pink
  "#4B0082", // indigo
  "#FF4500", // orange red
  "#2E8B57", // sea green
  "#DC143C", // crimson
  "#4682B4", // steel blue
];

/**
 * Convert hex color to RGBA number (for Jimp)
 * @param hex - Hex color string (e.g., "#FF0000")
 * @param alpha - Alpha value (0-255), default 255
 * @returns Unsigned 32-bit integer in RGBA format
 */
export function hexToRgba(hex: string, alpha = 255): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Use Jimp's built-in rgbaToInt utility
  return rgbaToInt(r, g, b, alpha);
}

/**
 * Get highlight color based on index and color scheme
 * @param index - Element index (0-based)
 * @param scheme - Color scheme: 'red' for single color, 'rainbow' for cycling
 */
export function getHighlightColor(
  index: number,
  scheme: 'red' | 'rainbow' = 'rainbow'
): { baseColor: string; backgroundColor: string } {
  if (scheme === 'red') {
    return {
      baseColor: "#FF0000",
      backgroundColor: "#FF00001A", // 10% opacity
    };
  }

  // Rainbow color cycling
  const colorIndex = index % HIGHLIGHT_COLORS.length;
  const baseColor = HIGHLIGHT_COLORS[colorIndex];
  const backgroundColor = baseColor + "1A"; // 10% opacity
  return { baseColor, backgroundColor };
}

/**
 * Get color as RGBA number for Jimp
 */
export function getHighlightColorRgba(
  index: number,
  scheme: 'red' | 'rainbow' = 'rainbow'
): number {
  const { baseColor } = getHighlightColor(index, scheme);
  return hexToRgba(baseColor);
}
