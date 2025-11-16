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

import type { BrowserContext, Page } from "playwright-core";
import { getCDPClient, getOrCreateFrameContextManager } from "@/cdp";
import type { CDPSession } from "@/cdp";
import { Protocol } from "devtools-protocol";
import { performance } from "perf_hooks";
import { getDebugOptions } from "@/debug/options";

const NETWORK_IDLE_THRESHOLD_MS = 500;
const STALLED_REQUEST_MS = 2000;
const STALLED_SWEEP_INTERVAL_MS = 500;
const ENV_TRACE_WAIT =
  process.env.HYPERAGENT_TRACE_WAIT === "1" ||
  process.env.HYPERAGENT_TRACE_WAIT === "true";

export interface LifecycleOptions {
  waitUntil?: Array<"domcontentloaded" | "load" | "networkidle">;
  timeoutMs?: number;
}

export interface WaitForSettledStats {
  durationMs: number;
  lifecycleMs: number;
  networkMs: number;
  requestsSeen: number;
  peakInflight: number;
  resolvedByTimeout: boolean;
  forcedDrops: number;
}

export async function waitForSettledDOM(
  page: Page,
  timeoutMs: number = 10000
): Promise<WaitForSettledStats> {
  const ctx = page.context() as BrowserContext & {
    _options?: { recordVideo?: unknown };
  };
  const debugOptions = getDebugOptions();
  const traceWaitFlag =
    (debugOptions.enabled && debugOptions.traceWait) || ENV_TRACE_WAIT;
  const traceWait = traceWaitFlag || !!ctx._options?.recordVideo;
  const totalStart = performance.now();

  // Currently we only wait for network idle (historical behavior). Hook exists if we add DOM states later.
  const lifecycleDuration = 0;
  if (traceWait) {
    console.log(
      `[Perf][waitForSettledDOM] lifecycle took ${lifecycleDuration.toFixed(
        0
      )}ms`
    );
  }

  const cdpClient = await getCDPClient(page);
  const manager = getOrCreateFrameContextManager(cdpClient);
  manager.setDebug(traceWait);

  const lifecycleSession = await cdpClient.acquireSession("lifecycle");

  const networkStart = performance.now();
  const stats = await waitForNetworkIdle(lifecycleSession, {
    timeoutMs,
    trace: traceWaitFlag,
  });
  const networkDuration = performance.now() - networkStart;

  if (traceWait) {
    console.log(
      `[Perf][waitForSettledDOM] networkidle took ${networkDuration.toFixed(
        0
      )}ms (requests=${stats.requestsSeen}, peakInflight=${
        stats.peakInflight
      }, reason=${stats.resolvedByTimeout ? "timeout" : "quiet"})`
    );
    const totalDuration = performance.now() - totalStart;
    console.log(
      `[Perf][waitForSettledDOM] total took ${totalDuration.toFixed(0)}ms`
    );
  }

  const totalDuration = performance.now() - totalStart;
  return {
    durationMs: totalDuration,
    lifecycleMs: lifecycleDuration,
    networkMs: networkDuration,
    requestsSeen: stats.requestsSeen,
    peakInflight: stats.peakInflight,
    resolvedByTimeout: stats.resolvedByTimeout,
    forcedDrops: stats.forcedDrops,
  };
}

interface NetworkIdleOptions {
  timeoutMs: number;
  trace?: boolean;
}

interface NetworkIdleStats {
  requestsSeen: number;
  peakInflight: number;
  resolvedByTimeout: boolean;
  forcedDrops: number;
}

async function waitForNetworkIdle(
  session: CDPSession,
  options: NetworkIdleOptions
): Promise<NetworkIdleStats> {
  const { timeoutMs, trace = false } = options;
  const inflight = new Set<string>();
  let quietTimer: NodeJS.Timeout | null = null;
  let globalTimeout: NodeJS.Timeout | null = null;
  const stats: NetworkIdleStats = {
    requestsSeen: 0,
    peakInflight: 0,
    resolvedByTimeout: false,
    forcedDrops: 0,
  };

  await new Promise<void>((resolve) => {
    const requestMeta = new Map<string, { url?: string; start: number }>();
    let stalledSweepTimer: NodeJS.Timeout | null = null;

    const maybeResolve = () => {
      if (inflight.size === 0 && !quietTimer) {
        quietTimer = setTimeout(
          () => resolveDone(false),
          NETWORK_IDLE_THRESHOLD_MS
        );
      }
    };

    const resolveDone = (byTimeout: boolean) => {
      stats.resolvedByTimeout = byTimeout;
      if (quietTimer) clearTimeout(quietTimer);
      if (globalTimeout) clearTimeout(globalTimeout);
      cleanup();
      resolve();
    };

    const cleanup = () => {
      if (session.off) {
        session.off("Network.requestWillBeSent", onRequestWillBeSent);
        session.off("Network.loadingFinished", onLoadingFinished);
        session.off("Network.loadingFailed", onLoadingFailed);
      }
      if (stalledSweepTimer) {
        clearInterval(stalledSweepTimer);
        stalledSweepTimer = null;
      }
    };

    const onRequestWillBeSent = (
      event: Protocol.Network.RequestWillBeSentEvent
    ): void => {
      if (event.type === "WebSocket" || event.type === "EventSource") {
        return;
      }
      inflight.add(event.requestId);
      stats.requestsSeen += 1;
      if (inflight.size > stats.peakInflight) {
        stats.peakInflight = inflight.size;
      }
      requestMeta.set(event.requestId, {
        url: event.request.url,
        start: Date.now(),
      });
      if (quietTimer) {
        clearTimeout(quietTimer);
        quietTimer = null;
      }
    };

    const onLoadingFinished = (
      event: Protocol.Network.LoadingFinishedEvent
    ): void => {
      finishRequest(event.requestId);
    };

    const onLoadingFailed = (
      event: Protocol.Network.LoadingFailedEvent
    ): void => {
      finishRequest(event.requestId);
    };

    session.on("Network.requestWillBeSent", onRequestWillBeSent);
    session.on("Network.loadingFinished", onLoadingFinished);
    session.on("Network.loadingFailed", onLoadingFailed);

    stalledSweepTimer = setInterval(() => {
      if (!requestMeta.size) return;
      const now = Date.now();
      for (const [id, meta] of requestMeta.entries()) {
        if (now - meta.start > STALLED_REQUEST_MS) {
          if (inflight.delete(id)) {
            stats.forcedDrops += 1;
            if (trace) {
              console.warn(
                `[waitForSettledDOM] Forcing completion of stalled request ${id} (age=${now - meta.start}ms url=${meta.url ?? "unknown"})`
              );
            }
            requestMeta.delete(id);
            maybeResolve();
          }
        }
      }
    }, STALLED_SWEEP_INTERVAL_MS);

    globalTimeout = setTimeout(() => resolveDone(true), timeoutMs);
    maybeResolve();

    function finishRequest(requestId: string): void {
      if (inflight.delete(requestId)) {
        requestMeta.delete(requestId);
        maybeResolve();
      }
    }
  });

  return stats;
}
