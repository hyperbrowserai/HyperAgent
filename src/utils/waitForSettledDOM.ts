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
import { formatUnknownError } from "@/utils";

const NETWORK_IDLE_THRESHOLD_MS = 500;
const STALLED_REQUEST_MS = 2000;
const STALLED_SWEEP_INTERVAL_MS = 500;
const MAX_WAIT_DIAGNOSTIC_CHARS = 400;
const MAX_WAIT_IDENTIFIER_CHARS = 200;
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const MAX_WAIT_TIMEOUT_MS = 120_000;
const ENV_TRACE_WAIT =
  process.env.HYPERAGENT_TRACE_WAIT === "1" ||
  process.env.HYPERAGENT_TRACE_WAIT === "true";

function sanitizeWaitDiagnosticText(value: string): string {
  if (value.length === 0) {
    return value;
  }
  const withoutControlChars = Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code < 32) || code === 127 ? " " : char;
  }).join("");
  return withoutControlChars.replace(/\s+/g, " ").trim();
}

function truncateWaitDiagnostic(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const omittedChars = value.length - maxChars;
  return `${value.slice(0, maxChars)}... [truncated ${omittedChars} chars]`;
}

function formatWaitIdentifier(value: unknown): string {
  if (typeof value !== "string") {
    return "unknown";
  }
  const normalized = sanitizeWaitDiagnosticText(value);
  if (normalized.length === 0) {
    return "unknown";
  }
  return truncateWaitDiagnostic(normalized, MAX_WAIT_IDENTIFIER_CHARS);
}

function formatWaitUrl(value: unknown): string {
  if (typeof value !== "string") {
    return "unknown";
  }
  const normalized = sanitizeWaitDiagnosticText(value);
  if (normalized.length === 0) {
    return "unknown";
  }
  return truncateWaitDiagnostic(normalized, MAX_WAIT_DIAGNOSTIC_CHARS);
}

function formatWaitDiagnostic(value: unknown): string {
  const normalized = sanitizeWaitDiagnosticText(formatUnknownError(value));
  if (normalized.length === 0) {
    return "unknown error";
  }
  return truncateWaitDiagnostic(normalized, MAX_WAIT_DIAGNOSTIC_CHARS);
}

function attachSessionListener<TPayload extends unknown[]>(
  session: CDPSession,
  event: string,
  handler: (...payload: TPayload) => void
): boolean {
  try {
    session.on(event, handler);
    return true;
  } catch (error) {
    console.warn(
      `[waitForSettledDOM] Failed to attach listener ${formatWaitIdentifier(
        event
      )}: ${formatWaitDiagnostic(error)}`
    );
    return false;
  }
}

function detachSessionListener<TPayload extends unknown[]>(
  session: CDPSession,
  event: string,
  handler: (...payload: TPayload) => void
): void {
  if (!session.off) {
    return;
  }
  try {
    session.off(event, handler);
  } catch (error) {
    console.warn(
      `[waitForSettledDOM] Failed to detach listener ${formatWaitIdentifier(
        event
      )}: ${formatWaitDiagnostic(error)}`
    );
  }
}

function normalizeWaitTimeoutMs(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_WAIT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(value), MAX_WAIT_TIMEOUT_MS);
}

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

export interface WaitForSettledOptions {
  filterAdTrackingFrames?: boolean;
}

function safeReadWaitOptionField(
  options: unknown,
  field: keyof WaitForSettledOptions
): unknown {
  if (!options || (typeof options !== "object" && typeof options !== "function")) {
    return undefined;
  }
  try {
    return (options as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

export async function waitForSettledDOM(
  page: Page,
  timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS,
  options: WaitForSettledOptions = {}
): Promise<WaitForSettledStats> {
  const normalizedTimeoutMs = normalizeWaitTimeoutMs(timeoutMs);
  const filterAdTrackingFramesOption = safeReadWaitOptionField(
    options,
    "filterAdTrackingFrames"
  );
  const filterAdTrackingFrames =
    typeof filterAdTrackingFramesOption === "boolean"
      ? filterAdTrackingFramesOption
      : undefined;
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
  try {
    manager.setDebug(traceWait);
  } catch (error) {
    console.warn(
      `[waitForSettledDOM] Failed to configure frame manager debug flag: ${formatWaitDiagnostic(
        error
      )}`
    );
  }
  if (
    typeof manager.setFrameFilteringEnabled === "function" &&
    typeof filterAdTrackingFrames === "boolean"
  ) {
    try {
      manager.setFrameFilteringEnabled(filterAdTrackingFrames);
    } catch (error) {
      console.warn(
        `[waitForSettledDOM] Failed to configure frame filtering: ${formatWaitDiagnostic(
          error
        )}`
      );
    }
  }

  const lifecycleSession = await cdpClient.acquireSession("lifecycle");

  const networkStart = performance.now();
  const stats = await waitForNetworkIdle(lifecycleSession, {
    timeoutMs: normalizedTimeoutMs,
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
    let listenerSetupFailed = false;

    const maybeResolve = () => {
      if (listenerSetupFailed) {
        return;
      }
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
      detachSessionListener(session, "Network.requestWillBeSent", onRequestWillBeSent);
      detachSessionListener(session, "Network.loadingFinished", onLoadingFinished);
      detachSessionListener(session, "Network.loadingFailed", onLoadingFailed);
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

    const requestListenerAttached = attachSessionListener(
      session,
      "Network.requestWillBeSent",
      onRequestWillBeSent
    );
    const loadingFinishedListenerAttached = attachSessionListener(
      session,
      "Network.loadingFinished",
      onLoadingFinished
    );
    const loadingFailedListenerAttached = attachSessionListener(
      session,
      "Network.loadingFailed",
      onLoadingFailed
    );
    listenerSetupFailed =
      !requestListenerAttached ||
      !loadingFinishedListenerAttached ||
      !loadingFailedListenerAttached;
    if (listenerSetupFailed) {
      console.warn(
        "[waitForSettledDOM] Network listeners could not be fully attached; falling back to timeout-based settle."
      );
    }

    stalledSweepTimer = setInterval(() => {
      if (!requestMeta.size) return;
      const now = Date.now();
      for (const [id, meta] of requestMeta.entries()) {
        if (now - meta.start > STALLED_REQUEST_MS) {
          if (inflight.delete(id)) {
            stats.forcedDrops += 1;
            if (trace) {
              console.warn(
                `[waitForSettledDOM] Forcing completion of stalled request ${formatWaitIdentifier(
                  id
                )} (age=${now - meta.start}ms url=${formatWaitUrl(
                  meta.url
                )})`
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
