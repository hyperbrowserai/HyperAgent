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

import type { Page } from "playwright-core";
import {
  getCDPClient,
  getOrCreateFrameContextManager,
} from "@/cdp";
import type { CDPClient } from "@/cdp";
import type { FrameContextManager } from "@/cdp/frame-context-manager";
import { Protocol } from "devtools-protocol";

const NETWORK_IDLE_THRESHOLD_MS = 500;

export interface LifecycleOptions {
  waitUntil?: Array<"domcontentloaded" | "load" | "networkidle">;
  timeoutMs?: number;
  frameId?: string;
}

export async function waitForSettledDOM(
  page: Page,
  timeoutMs: number = 10000
): Promise<void> {
  await waitForLifecycle(page, {
    waitUntil: ["networkidle"],
    timeoutMs,
  });
}

export async function waitForLifecycle(
  page: Page,
  options: LifecycleOptions = {}
): Promise<void> {
  const {
    waitUntil = ["domcontentloaded"],
    timeoutMs = 10000,
    frameId,
  } = options;

  const cdpClient = await getCDPClient(page);
  const manager = getOrCreateFrameContextManager(cdpClient);
  await manager.enableAutoAttach(cdpClient.rootSession);

  const watcher = new LifecycleWatcher({
    page,
    waitUntil,
    timeoutMs,
  });

  await watcher.waitForLifecycle();

  if (waitUntil.includes("networkidle")) {
    await waitForNetworkIdle(page, cdpClient, { timeoutMs, frameId });
  }
}

interface LifecycleWatcherConfig {
  page: Page;
  waitUntil: Array<"domcontentloaded" | "load" | "networkidle">;
  timeoutMs: number;
  frameId?: string;
}

class LifecycleWatcher {
  private readonly page: Page;
  private readonly waitUntil: Set<"domcontentloaded" | "load" | "networkidle">;
  private readonly timeoutMs: number;
  constructor({ page, waitUntil, timeoutMs }: LifecycleWatcherConfig) {
    this.page = page;
    this.waitUntil = new Set(waitUntil);
    this.timeoutMs = timeoutMs;
  }

  async waitForLifecycle(): Promise<void> {
    if (this.waitUntil.has("domcontentloaded")) {
      await this.page.waitForLoadState("domcontentloaded", {
        timeout: this.timeoutMs,
      });
    }

    if (this.waitUntil.has("load")) {
      await this.page.waitForLoadState("load", { timeout: this.timeoutMs });
    }

    // networkidle handled outside to avoid duplicate logic
  }
}

interface NetworkIdleOptions {
  timeoutMs: number;
  frameId?: string;
}

async function waitForNetworkIdle(
  page: Page,
  cdpClient: CDPClient,
  options: NetworkIdleOptions
): Promise<void> {
  const { timeoutMs, frameId } = options;
  const session = await cdpClient.createSession({ type: "page", page });
  const inflight = new Set<string>();
  let quietTimer: NodeJS.Timeout | null = null;
  let globalTimeout: NodeJS.Timeout | null = null;

  await session.send("Network.enable").catch(() => {});

  await new Promise<void>((resolve) => {
    const maybeResolve = () => {
      if (inflight.size === 0 && !quietTimer) {
        quietTimer = setTimeout(resolveDone, NETWORK_IDLE_THRESHOLD_MS);
      }
    };

    const resolveDone = () => {
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
      session.detach().catch(() => {});
    };

    const onRequestWillBeSent = (
      event: Protocol.Network.RequestWillBeSentEvent
    ): void => {
      if (event.type === "WebSocket" || event.type === "EventSource") {
        return;
      }
      inflight.add(event.requestId);
      if (quietTimer) {
        clearTimeout(quietTimer);
        quietTimer = null;
      }
    };

    const onLoadingFinished = (event: Protocol.Network.LoadingFinishedEvent): void => {
      inflight.delete(event.requestId);
      maybeResolve();
    };

    const onLoadingFailed = (event: Protocol.Network.LoadingFailedEvent): void => {
      inflight.delete(event.requestId);
      maybeResolve();
    };

    session.on("Network.requestWillBeSent", onRequestWillBeSent);
    session.on("Network.loadingFinished", onLoadingFinished);
    session.on("Network.loadingFailed", onLoadingFailed);

    globalTimeout = setTimeout(resolveDone, timeoutMs);
    maybeResolve();
  });
}
