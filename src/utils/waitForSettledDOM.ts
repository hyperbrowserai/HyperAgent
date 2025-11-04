/**
 * Wait for DOM to settle by monitoring network activity
 *
 * Definition of "settled":
 * - No in-flight network requests (except WebSocket / Server-Sent-Events)
 * - That idle state lasts for at least 500ms (the "quiet-window")
 *
 * How it works:
 * 1. Subscribe to CDP Network and Page events
 * 2. Track in-flight requests with metadata (URL, start time)
 * 3. Stalled request sweep: Force-complete requests stuck for >2 seconds
 * 4. Handle Document requests and frameStoppedLoading events
 * 5. When no requests for 500ms, consider DOM settled
 * 6. Global timeout ensures we don't wait forever
 */

import { Page } from "playwright-core";
import { Protocol } from "devtools-protocol";

export async function waitForSettledDOM(
  page: Page,
  timeoutMs: number = 10000
): Promise<void> {
  try {
    const client = await page.context().newCDPSession(page);

    try {
      // Check if document exists
      const hasDoc = !!(await page.title().catch(() => false));
      if (!hasDoc) {
        await page.waitForLoadState("domcontentloaded");
      }

      await client.send("Network.enable");
      await client.send("Page.enable");
      await client.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [
          { type: "worker", exclude: true },
          { type: "shared_worker", exclude: true },
        ],
      });

      return await new Promise<void>((resolve) => {
        const inflight = new Set<string>();
        const meta = new Map<string, { url: string; start: number }>();
        const docByFrame = new Map<string, string>();

        let quietTimer: NodeJS.Timeout | null = null;
        let stalledRequestSweepTimer: NodeJS.Timeout | null = null;
        let globalTimeout: NodeJS.Timeout | null = null;

        const clearQuiet = () => {
          if (quietTimer) {
            clearTimeout(quietTimer);
            quietTimer = null;
          }
        };

        const maybeQuiet = () => {
          if (inflight.size === 0 && !quietTimer) {
            // Wait 500ms for no network activity before considering DOM settled
            quietTimer = setTimeout(() => resolveDone(), 500);
          }
        };

        const finishReq = (id: string) => {
          if (!inflight.delete(id)) return;
          meta.delete(id);
          for (const [fid, rid] of docByFrame) {
            if (rid === id) docByFrame.delete(fid);
          }
          clearQuiet();
          maybeQuiet();
        };

        const resolveDone = () => {
          cleanup();
          resolve();
        };

        // Define event handlers as named functions so we can remove them in cleanup
        const onRequestWillBeSent = (
          params: Protocol.Network.RequestWillBeSentEvent
        ) => {
          // Skip WebSocket and EventSource
          if (params.type === "WebSocket" || params.type === "EventSource") {
            return;
          }

          inflight.add(params.requestId);
          meta.set(params.requestId, {
            url: params.request.url,
            start: Date.now(),
          });

          // Track Document requests by frame
          if (params.type === "Document" && params.frameId) {
            docByFrame.set(params.frameId, params.requestId);
          }

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

        const onResponseReceived = (
          params: Protocol.Network.ResponseReceivedEvent
        ) => {
          // Handle data: URLs - they don't get loadingFinished events
          if (params.response.url.startsWith("data:")) {
            finishReq(params.requestId);
          }
        };

        const onFrameStoppedLoading = (
          params: Protocol.Page.FrameStoppedLoadingEvent
        ) => {
          const id = docByFrame.get(params.frameId);
          if (id) finishReq(id);
        };

        const cleanup = () => {
          if (quietTimer) clearTimeout(quietTimer);
          if (globalTimeout) clearTimeout(globalTimeout);
          if (stalledRequestSweepTimer) clearInterval(stalledRequestSweepTimer);

          // Remove event listeners
          client.off("Network.requestWillBeSent", onRequestWillBeSent);
          client.off("Network.loadingFinished", onLoadingFinished);
          client.off("Network.loadingFailed", onLoadingFailed);
          client.off(
            "Network.requestServedFromCache",
            onRequestServedFromCache
          );
          client.off("Network.responseReceived", onResponseReceived);
          client.off("Page.frameStoppedLoading", onFrameStoppedLoading);
        };

        // Global timeout
        globalTimeout = setTimeout(() => {
          if (inflight.size) {
            console.log(
              `[waitForSettledDOM] Timeout after ${timeoutMs}ms, ${inflight.size} requests still in flight`
            );
          }
          resolveDone();
        }, timeoutMs);

        // Stalled request sweep - force complete requests stuck for >2 seconds
        stalledRequestSweepTimer = setInterval(() => {
          const now = Date.now();
          for (const [id, m] of meta) {
            if (now - m.start > 2000) {
              inflight.delete(id);
              meta.delete(id);
              console.log(
                `[waitForSettledDOM] Forcing completion of stalled request: ${m.url.slice(0, 120)}`
              );
            }
          }
          maybeQuiet();
        }, 500);

        // Register network event handlers
        client.on("Network.requestWillBeSent", onRequestWillBeSent);
        client.on("Network.loadingFinished", onLoadingFinished);
        client.on("Network.loadingFailed", onLoadingFailed);
        client.on("Network.requestServedFromCache", onRequestServedFromCache);
        client.on("Network.responseReceived", onResponseReceived);
        client.on("Page.frameStoppedLoading", onFrameStoppedLoading);

        // Start the quiet check
        maybeQuiet();
      });
    } finally {
      await client.detach();
    }
  } catch (error) {
    // If CDP fails, just wait a fixed time
    console.warn(
      "[waitForSettledDOM] CDP failed, falling back to fixed wait:",
      error
    );
    await page.waitForTimeout(1000);
  }
}
