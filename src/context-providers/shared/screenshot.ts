/**
 * Screenshot composition utilities
 * Composites overlay images with base screenshots using Jimp
 */

import { Jimp } from "jimp";
import type { Page } from "playwright-core";

/**
 * Composite an overlay image onto a page screenshot
 *
 * @param page - Playwright page to screenshot
 * @param overlayBase64 - Base64-encoded PNG overlay image
 * @returns Base64-encoded PNG of the composite image
 */
export async function compositeScreenshot(
  page: Page,
  overlayBase64: string
): Promise<string> {
  const screenshot = await page.screenshot({ type: "png" });

  const [baseImage, overlayImage] = await Promise.all([
    Jimp.read(screenshot as Buffer),
    Jimp.read(Buffer.from(overlayBase64, "base64")),
  ]);

  baseImage.composite(overlayImage, 0, 0);
  const buffer = await baseImage.getBuffer("image/png");
  return buffer.toString("base64");
}

/**
 * Composite an overlay image onto an existing screenshot buffer
 *
 * @param screenshotBuffer - Screenshot as Buffer
 * @param overlayBase64 - Base64-encoded PNG overlay image
 * @returns Base64-encoded PNG of the composite image
 */
export async function compositeScreenshotBuffer(
  screenshotBuffer: Buffer,
  overlayBase64: string
): Promise<string> {
  const [baseImage, overlayImage] = await Promise.all([
    Jimp.read(screenshotBuffer),
    Jimp.read(Buffer.from(overlayBase64, "base64")),
  ]);

  baseImage.composite(overlayImage, 0, 0);
  const buffer = await baseImage.getBuffer("image/png");
  return buffer.toString("base64");
}
