export interface AttachDriverToCDPOptions {
  wsEndpoint: string;
  connectWith: "playwright" | "puppeteer";
}

/**
 * Placeholder helper for Phase 4 connectors. This will eventually accept a browser
 * context (Playwright, Puppeteer, or raw CDP) and attach it to the shared CDP pipeline.
 */
export async function attachDriverToCDP(
  _options: AttachDriverToCDPOptions
): Promise<never> {
  throw new Error(
    "attachDriverToCDP is not implemented yet. See docs/phase4-browser-driver-abstraction.md"
  );
}
