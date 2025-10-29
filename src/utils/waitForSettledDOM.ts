/**
 * Wait for DOM to settle - based on Stagehand's _waitForSettledDom implementation
 *
 * Definition of "settled":
 * - No in-flight network requests (except WebSocket / Server-Sent-Events)
 * - That idle state lasts for at least 500ms (the "quiet-window")
 *
 * How it works:
 * 1. Subscribe to CDP Network events
 * 2. Track in-flight requests
 * 3. When no requests for 500ms, consider DOM settled
 * 4. Global timeout ensures we don't wait forever
 */

import { Page } from 'patchright';
import { Protocol } from 'devtools-protocol';

export async function waitForSettledDOM(
  page: Page,
  timeoutMs: number = 30000
): Promise<void> {
  try {
    const client = await page.context().newCDPSession(page);

    try {
      // Check if document exists
      const hasDoc = !!(await page.title().catch(() => false));
      if (!hasDoc) {
        await page.waitForLoadState('domcontentloaded');
      }

      await client.send('Network.enable');

      return await new Promise<void>((resolve) => {
        const inflight = new Set<string>();
        let quietTimer: NodeJS.Timeout | null = null;
        let globalTimeout: NodeJS.Timeout | null = null;

        const clearQuiet = () => {
          if (quietTimer) {
            clearTimeout(quietTimer);
            quietTimer = null;
          }
        };

        const maybeQuiet = () => {
          if (inflight.size === 0 && !quietTimer) {
            quietTimer = setTimeout(() => resolveDone(), 500);
          }
        };

        const finishReq = (id: string) => {
          if (!inflight.delete(id)) return;
          clearQuiet();
          maybeQuiet();
        };

        const resolveDone = () => {
          cleanup();
          resolve();
        };

        // Define event handlers as named functions so we can remove them in cleanup
        const onRequestWillBeSent = (params: Protocol.Network.RequestWillBeSentEvent) => {
          const { requestId, request } = params;
          // Skip WebSocket and Server-Sent-Events
          if (request.url?.startsWith('ws://') || request.url?.startsWith('wss://')) {
            return;
          }
          inflight.add(requestId);
          clearQuiet();
        };

        const onLoadingFinished = (params: { requestId: string }) => {
          finishReq(params.requestId);
        };

        const onLoadingFailed = (params: { requestId: string }) => {
          finishReq(params.requestId);
        };

        const onRequestServedFromCache = (params: { requestId: string }) => {
          finishReq(params.requestId);
        };

        const cleanup = () => {
          if (quietTimer) clearTimeout(quietTimer);
          if (globalTimeout) clearTimeout(globalTimeout);
          // Remove event listeners (don't detach here - that happens in finally block)
          client.off('Network.requestWillBeSent', onRequestWillBeSent);
          client.off('Network.loadingFinished', onLoadingFinished);
          client.off('Network.loadingFailed', onLoadingFailed);
          client.off('Network.requestServedFromCache', onRequestServedFromCache);
        };

        // Global timeout
        globalTimeout = setTimeout(() => {
          console.log(`[waitForSettledDOM] Timeout after ${timeoutMs}ms, ${inflight.size} requests still in flight`);
          resolveDone();
        }, timeoutMs);

        // Register network event handlers
        client.on('Network.requestWillBeSent', onRequestWillBeSent);
        client.on('Network.loadingFinished', onLoadingFinished);
        client.on('Network.loadingFailed', onLoadingFailed);
        client.on('Network.requestServedFromCache', onRequestServedFromCache);

        // Start the quiet check
        maybeQuiet();
      });
    } finally {
      await client.detach();
    }
  } catch (error) {
    // If CDP fails, just wait a fixed time
    console.warn('[waitForSettledDOM] CDP failed, falling back to fixed wait:', error);
    await page.waitForTimeout(1000);
  }
}
