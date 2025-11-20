import { Page } from "playwright-core";

import { sha256 } from "@/utils/hash";

export async function computeDomHash(
  page: Page,
  domState: string
): Promise<string | null> {
  if (!domState || !domState.trim()) {
    return null;
  }

  try {
    let viewport = page.viewportSize();
    if (!viewport) {
      viewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));
    }

    const viewportLabel = viewport
      ? `${viewport.width}x${viewport.height}`
      : "unknown-viewport";

    const url = page.url();
    const payload = `${url}::${viewportLabel}::${domState}`;
    return sha256(payload);
  } catch {
    return null;
  }
}
