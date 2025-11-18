import type { Protocol } from "devtools-protocol";
import type { CDPSession, CDPClient } from "./types";
import type { FrameRecord } from "./frame-graph";
import { FrameGraph } from "./frame-graph";
import { isAdOrTrackingFrame } from "./frame-filters";

interface FrameTreeNode {
  frame: Protocol.Page.Frame;
  childFrames?: FrameTreeNode[];
}

type PlaywrightFrameHandle = {
  url(): string;
  parentFrame(): unknown | null;
  name(): string;
  isDetached?: () => boolean;
};

interface PlaywrightOOPIFRecord {
  frameId: string;
  session: CDPSession;
  url: string;
  name?: string;
  parentFrameUrl?: string | null;
  playwrightFrame: PlaywrightFrameHandle;
  detachHandler?: () => void;
}

interface UpsertFrameInput
  extends Partial<
    Omit<FrameRecord, "frameId" | "parentFrameId" | "lastUpdated">
  > {
  frameId: string;
  parentFrameId: string | null;
}

export class FrameContextManager {
  private readonly graph = new FrameGraph();
  private readonly sessions = new Map<string, CDPSession>();
  private readonly frameExecutionContexts = new Map<string, number>();
  private readonly executionContextToFrame = new Map<number, string>();
  private readonly executionContextWaiters = new Map<
    string,
    Set<{ resolve: (value?: number) => void; timeoutId?: NodeJS.Timeout }>
  >();
  private readonly runtimeTrackedSessions = new WeakSet<CDPSession>();
  private readonly sessionListeners = new Map<
    CDPSession,
    Array<{ event: string; handler: (...args: unknown[]) => void }>
  >();
  private readonly oopifFrameIds = new Set<string>();
  private readonly pageTrackedSessions = new WeakSet<CDPSession>();
  private readonly playwrightOopifCache = new Map<
    PlaywrightFrameHandle,
    PlaywrightOOPIFRecord
  >();
  private nextFrameIndex = 0;
  private initialized = false;
  private initializingPromise: Promise<void> | null = null;
  private debugLogs = false;

  constructor(private readonly client: CDPClient) {}

  setDebug(debug?: boolean): void {
    this.debugLogs = !!debug;
  }

  private log(message: string): void {
    if (this.debugLogs) {
      console.log(message);
    }
  }
  private removeCachedPlaywrightFrame(frame: PlaywrightFrameHandle): void {
    const record = this.playwrightOopifCache.get(frame);
    if (!record) return;
    if (record.detachHandler) {
      record.session.off?.("Detached", record.detachHandler);
      record.detachHandler = undefined;
    }
    this.playwrightOopifCache.delete(frame);
  }

  get frameGraph(): FrameGraph {
    return this.graph;
  }

  upsertFrame(input: UpsertFrameInput): FrameRecord {
    return this.graph.upsertFrame({
      ...input,
      lastUpdated: Date.now(),
    });
  }

  removeFrame(frameId: string): void {
    this.graph.removeFrame(frameId);
    this.sessions.delete(frameId);
  }

  assignFrameIndex(frameId: string, index: number): void {
    this.graph.assignFrameIndex(frameId, index);
    if (index >= this.nextFrameIndex) {
      this.nextFrameIndex = index + 1;
    }
  }

  setFrameSession(frameId: string, session: CDPSession): void {
    this.sessions.set(frameId, session);
    const record = this.graph.getFrame(frameId);
    if (record) {
      this.graph.upsertFrame({
        ...record,
        sessionId: (session as { id?: string }).id ?? record.sessionId,
        parentFrameId: record.parentFrameId,
      });
    }
    this.trackRuntimeForSession(session);
  }

  getFrameSession(frameId: string): CDPSession | undefined {
    return this.sessions.get(frameId);
  }

  getFrame(frameId: string): FrameRecord | undefined {
    return this.graph.getFrame(frameId);
  }

  getFrameByBackendNodeId(backendNodeId: number): FrameRecord | undefined {
    return this.graph
      .getAllFrames()
      .find((frame) => frame.backendNodeId === backendNodeId);
  }

  getFrameIdByIndex(index: number): string | undefined {
    return this.graph.getFrameIdByIndex(index);
  }

  getFrameByIndex(index: number): FrameRecord | undefined {
    const frameId = this.graph.getFrameIdByIndex(index);
    if (!frameId) return undefined;
    return this.graph.getFrame(frameId);
  }

  getFrameIndex(frameId: string): number | undefined {
    return this.graph.getFrameIndex(frameId);
  }

  getExecutionContextId(frameId: string): number | undefined {
    return this.frameExecutionContexts.get(frameId);
  }

  async waitForExecutionContext(
    frameId: string,
    timeoutMs = 750
  ): Promise<number | undefined> {
    const existing = this.frameExecutionContexts.get(frameId);
    if (typeof existing === "number") {
      return existing;
    }

    return await new Promise<number | undefined>((resolve) => {
      const waiter = { resolve: (value?: number) => resolve(value) } as {
        resolve: (value?: number) => void;
        timeoutId?: NodeJS.Timeout;
      };

      waiter.timeoutId = setTimeout(() => {
        const waiters = this.executionContextWaiters.get(frameId);
        if (waiters) {
          waiters.delete(waiter);
          if (waiters.size === 0) {
            this.executionContextWaiters.delete(frameId);
          }
        }
        resolve(undefined);
      }, timeoutMs);

      let waiters = this.executionContextWaiters.get(frameId);
      if (!waiters) {
        waiters = new Set();
        this.executionContextWaiters.set(frameId, waiters);
      }
      waiters.add(waiter);
    });
  }

  /**
   * Get all same-origin frames (use main session for these)
   */
  getSameOriginFrames(): FrameRecord[] {
    return this.graph
      .getAllFrames()
      .filter((frame: FrameRecord) => !this.oopifFrameIds.has(frame.frameId));
  }

  /**
   * Get all OOPIF frames (each has its own session)
   */
  getOOPIFs(): FrameRecord[] {
    return this.graph
      .getAllFrames()
      .filter((frame: FrameRecord) => this.oopifFrameIds.has(frame.frameId));
  }

  /**
   * Check if a frame is an OOPIF
   */
  isOOPIF(frameId: string): boolean {
    return this.oopifFrameIds.has(frameId);
  }

  toJSON(): { graph: ReturnType<FrameGraph["toJSON"]> } {
    return { graph: this.graph.toJSON() };
  }

  clear(): void {
    this.graph.clear();
    this.sessions.clear();
    this.frameExecutionContexts.clear();
    this.executionContextToFrame.clear();

    for (const waiters of this.executionContextWaiters.values()) {
      for (const waiter of waiters) {
        if (waiter.timeoutId) clearTimeout(waiter.timeoutId);
        waiter.resolve(undefined);
      }
    }
    this.executionContextWaiters.clear();

    for (const [session, listeners] of this.sessionListeners.entries()) {
      for (const { event, handler } of listeners) {
        session.off?.(event, handler);
      }
    }
    this.sessionListeners.clear();

    this.oopifFrameIds.clear();
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initializingPromise) return this.initializingPromise;

    this.initializingPromise = (async () => {
      const rootSession = this.client.rootSession;
      await this.captureFrameTree(rootSession);
      await this.trackPageEvents(rootSession);
      this.initialized = true;
    })().finally(() => {
      this.initializingPromise = null;
    });

    return this.initializingPromise;
  }

  /**
   * Capture initial frame tree from CDP (both same-origin and OOPIF frames)
   * Assigns preliminary frameIndex values which may be overwritten by DOM traversal order
   * in syncFrameContextManager for same-origin iframes
   */
  private async captureFrameTree(session: CDPSession): Promise<void> {
    const { frameTree } =
      await session.send<Protocol.Page.GetFrameTreeResponse>(
        "Page.getFrameTree"
      );
    if (!frameTree) return;

    const traverse = async (
      node: FrameTreeNode,
      parentFrameId: string | null
    ): Promise<void> => {
      const frameId = node.frame.id;
      const record = this.upsertFrame({
        frameId,
        parentFrameId,
        loaderId: node.frame.loaderId,
        name: node.frame.name,
        url: node.frame.url,
      });

      this.setFrameSession(frameId, session);

      if (record.parentFrameId !== null) {
        await this.populateFrameOwner(session, frameId);
      }

      for (const child of node.childFrames ?? []) {
        await traverse(child, frameId);
      }
    };

    await traverse(frameTree, frameTree.frame?.parentId ?? null);
  }

  /**
   * Get the backendNodeId of the <iframe> element that owns this frame
   * This backendNodeId is crucial for matching same-origin iframes between:
   * - DOM traversal (buildBackendIdMaps) which has backendNodeId but may not have frameId
   * - CDP events (FrameContextManager) which has frameId from Page.frameAttached
   */
  private async populateFrameOwner(
    session: CDPSession,
    frameId: string
  ): Promise<void> {
    try {
      const owner = await session.send<Protocol.DOM.GetFrameOwnerResponse>(
        "DOM.getFrameOwner",
        { frameId }
      );
      const record = this.graph.getFrame(frameId);
      if (!record) return;
      this.graph.upsertFrame({
        ...record,
        backendNodeId: owner.backendNodeId ?? record.backendNodeId,
      });
    } catch {
      // Ignore errors when getting frame owner (e.g., for main frame or OOPIF)
    }
  }

  private getFrameIdByUrl(url: string): string | null {
    if (!url || url === "about:blank") return null;

    for (const frame of this.graph.getAllFrames()) {
      if (frame.url === url) return frame.frameId;
    }
    return null;
  }

  /**
   * Discover OOPIF (Out-of-Process IFrame) frames
   *
   * OOPIF frames are cross-origin and WON'T appear in DOM.getDocument response
   * (pierce:true doesn't cross origin boundaries for security reasons)
   *
   * They must be discovered via CDP Target/Session events and have their own CDP sessions.
   * OOPIF frames always have frameId since they're separate CDP targets.
   *
   * Discovery strategy: Try to create a CDP session for each frame - if it succeeds, it's an OOPIF
   */
  public async captureOOPIFs(startIndex: number): Promise<void> {
    const pageUnknown = this.client.getPage?.();
    if (!pageUnknown) {
      this.log("[FrameContext] No page available for OOPIF discovery");
      return;
    }

    // Type cast to Playwright Page - this is safe because we're using PlaywrightCDPClient
    const page = pageUnknown as {
      context(): { newCDPSession(frame: unknown): Promise<CDPSession> };
      frames(): Array<PlaywrightFrameHandle>;
      mainFrame(): unknown;
    };

    const context = page.context();
    const allFrames = page.frames();

    // Cleanup any previously tracked Playwright frames that are no longer present or detached
    const frameSet = new Set(allFrames);
    for (const tracked of Array.from(this.playwrightOopifCache.keys())) {
      const isDetached =
        typeof tracked.isDetached === "function" && tracked.isDetached();
      if (!frameSet.has(tracked) || isDetached) {
        this.removeCachedPlaywrightFrame(tracked);
      }
    }

    // Filter frames to process (exclude main frame)
    const framesToCheck = allFrames.filter(
      (frame) => frame !== page.mainFrame()
    );

    if (framesToCheck.length === 0) {
      return;
    }

    // Parallelize OOPIF discovery: try to create CDP session for all frames simultaneously
    const discoveryPromises = framesToCheck.map(async (frame, index) => {
      const cachedRecord = this.playwrightOopifCache.get(frame);
      const parentFrameUnknown = frame.parentFrame();
      const parentFrame = parentFrameUnknown as { url(): string } | null;
      const parentFrameUrl = parentFrame?.url();

      if (cachedRecord) {
        this.log(
          `[FrameContext] Frame ${frame.url()} already has a cached record, skipping`
        );
        if (typeof frame.isDetached === "function" && frame.isDetached()) {
          this.log(
            `[FrameContext] Frame ${frame.url()} is detached, removing cached record`
          );
          this.removeCachedPlaywrightFrame(frame);
          return null;
        }
        cachedRecord.url = frame.url();
        cachedRecord.name = frame.name() || undefined;
        cachedRecord.parentFrameUrl = parentFrameUrl;
        cachedRecord.playwrightFrame = frame;
        return {
          ...cachedRecord,
          discoveryOrder: index,
          playwrightFrame: frame,
        };
      }
      const frameUrl = frame.url();

      // Filter ad/tracking frames before attempting CDP session creation
      if (isAdOrTrackingFrame({ url: frameUrl, name: frame.name(), parentUrl: parentFrameUrl || undefined })) {
        this.log(`[FrameContext] Skipping ad/tracking frame: ${frameUrl}`);
        return null;
      }

      // Try to create CDP session - if it succeeds, this is an OOPIF
      let oopifSession: CDPSession | null = null;
      try {
        oopifSession = await context.newCDPSession(frame);
      } catch {
        // Failed to create session = same-origin frame (already processed via DOM.getDocument)
        this.log(`[FrameContext] Frame ${frameUrl} is same-origin, skipping`);
        return null;
      }

      // Success! This is an OOPIF - get its CDP frame ID
      try {
        await oopifSession.send("Page.enable");
        const { frameTree } = await oopifSession.send("Page.getFrameTree");
        const frameId = frameTree.frame.id;

        this.log(
          `[FrameContext] Discovered OOPIF: frameId=${frameId}, url=${frameUrl}`
        );

        const record: PlaywrightOOPIFRecord = {
          frameId,
          session: oopifSession,
          url: frameUrl,
          name: frame.name() || undefined,
          parentFrameUrl,
          playwrightFrame: frame,
        };
        const detachHandler = (): void => {
          this.removeCachedPlaywrightFrame(frame);
          oopifSession?.off?.("Detached", detachHandler);
        };
        record.detachHandler = detachHandler;
        oopifSession.on?.("Detached", detachHandler);
        this.playwrightOopifCache.set(frame, record);

        return {
          ...record,
          discoveryOrder: index, // Preserve original order for deterministic frame indices
          playwrightFrame: frame,
        };
      } catch (_error) {
        this.log(
          `[FrameContext] Failed to process OOPIF ${frameUrl}: ${_error}`
        );
        if (oopifSession) {
          await oopifSession.detach().catch(() => {
            // ignore detach errors
          });
        }
        return null;
      }
    });

    // Wait for all OOPIF discovery to complete in parallel
    const discoveredOOPIFs = (await Promise.all(discoveryPromises)).filter(
      (result): result is NonNullable<typeof result> => result !== null
    );

    // Now assign frame indices and register all OOPIFs in deterministic order
    // Sort by discovery order to maintain deterministic frame indices
    discoveredOOPIFs.sort((a, b) => a.discoveryOrder - b.discoveryOrder);

    for (let i = 0; i < discoveredOOPIFs.length; i++) {
      const oopif = discoveredOOPIFs[i];
      const frameIndex = startIndex + i;
      const parentFrameId = oopif.parentFrameUrl
        ? this.getFrameIdByUrl(oopif.parentFrameUrl)
        : null;

      this.setFrameSession(oopif.frameId, oopif.session);
      this.assignFrameIndex(oopif.frameId, frameIndex);

      this.oopifFrameIds.add(oopif.frameId);
      this.upsertFrame({
        frameId: oopif.frameId,
        parentFrameId,
        url: oopif.url,
        name: oopif.name,
      });
    }
  }

  private async trackPageEvents(session: CDPSession): Promise<void> {
    if (this.pageTrackedSessions.has(session)) {
      return;
    }
    this.pageTrackedSessions.add(session);

    await session
      .send("Page.enable")
      .catch((error) =>
        console.warn("[FrameContext] Failed to enable Page domain:", error)
      );

    const attachedHandler = (event: Protocol.Page.FrameAttachedEvent): void => {
      this.handlePageFrameAttached(event).catch((error) =>
        console.warn("[FrameContext] Error handling frameAttached:", error)
      );
    };

    const detachedHandler = (event: Protocol.Page.FrameDetachedEvent): void => {
      this.handlePageFrameDetached(event);
    };

    const navigatedHandler = (
      event: Protocol.Page.FrameNavigatedEvent
    ): void => {
      this.handlePageFrameNavigated(event);
    };

    session.on("Page.frameAttached", attachedHandler);
    session.on("Page.frameDetached", detachedHandler);
    session.on("Page.frameNavigated", navigatedHandler);

    const listeners = this.sessionListeners.get(session) ?? [];
    listeners.push(
      {
        event: "Page.frameAttached",
        handler: attachedHandler as (...args: unknown[]) => void,
      },
      {
        event: "Page.frameDetached",
        handler: detachedHandler as (...args: unknown[]) => void,
      },
      {
        event: "Page.frameNavigated",
        handler: navigatedHandler as (...args: unknown[]) => void,
      }
    );
    this.sessionListeners.set(session, listeners);
  }

  private async handlePageFrameAttached(
    event: Protocol.Page.FrameAttachedEvent
  ): Promise<void> {
    const frameId = event.frameId;
    const parentFrameId = event.parentFrameId ?? null;
    if (this.graph.getFrame(frameId)) {
      return;
    }

    this.upsertFrame({
      frameId,
      parentFrameId,
    });
    if (typeof this.graph.getFrameIndex(frameId) === "undefined") {
      const index = this.nextFrameIndex++;
      this.assignFrameIndex(frameId, index);
    }
    const rootSession = this.client.rootSession;
    this.setFrameSession(frameId, rootSession);
    await this.populateFrameOwner(rootSession, frameId);
    this.log(
      `[FrameContext] Page.frameAttached: frameId=${frameId}, parent=${parentFrameId ?? "root"}`
    );
  }

  private handlePageFrameDetached(
    event: Protocol.Page.FrameDetachedEvent
  ): void {
    const frameId = event.frameId;
    if (!this.graph.getFrame(frameId)) {
      return;
    }
    this.removeFrame(frameId);
    this.log(`[FrameContext] Page.frameDetached: frameId=${frameId}`);
  }

  private handlePageFrameNavigated(
    event: Protocol.Page.FrameNavigatedEvent
  ): void {
    const frameId = event.frame.id;
    this.upsertFrame({
      frameId,
      parentFrameId: event.frame.parentId ?? null,
      loaderId: event.frame.loaderId,
      url: event.frame.url,
      name: event.frame.name,
    });
    this.log(
      `[FrameContext] Page.frameNavigated: frameId=${frameId}, url=${event.frame.url}`
    );
  }

  private trackRuntimeForSession(session: CDPSession): void {
    if (this.runtimeTrackedSessions.has(session)) {
      return;
    }
    this.runtimeTrackedSessions.add(session);

    const createdHandler = (
      event: Protocol.Runtime.ExecutionContextCreatedEvent
    ): void => {
      const auxData = event.context.auxData as
        | { frameId?: string; type?: string }
        | undefined;
      const frameId = auxData?.frameId;
      if (!frameId) return;
      const contextType = auxData?.type;
      if (contextType && contextType !== "default") return;

      this.frameExecutionContexts.set(frameId, event.context.id);
      this.executionContextToFrame.set(event.context.id, frameId);

      const record = this.graph.getFrame(frameId);
      if (record && record.executionContextId !== event.context.id) {
        this.graph.upsertFrame({
          ...record,
          executionContextId: event.context.id,
        });
      }

      const waiters = this.executionContextWaiters.get(frameId);
      if (waiters) {
        for (const waiter of waiters) {
          if (waiter.timeoutId) clearTimeout(waiter.timeoutId);
          waiter.resolve(event.context.id);
        }
        this.executionContextWaiters.delete(frameId);
      }
    };

    const destroyedHandler = (
      event: Protocol.Runtime.ExecutionContextDestroyedEvent
    ): void => {
      const frameId = this.executionContextToFrame.get(
        event.executionContextId
      );
      if (!frameId) {
        return;
      }
      this.executionContextToFrame.delete(event.executionContextId);
      this.frameExecutionContexts.delete(frameId);
    };

    const clearedHandler = (): void => {
      for (const [frameId, frameSession] of this.sessions.entries()) {
        if (frameSession !== session) continue;
        const contextId = this.frameExecutionContexts.get(frameId);
        if (typeof contextId === "number") {
          this.frameExecutionContexts.delete(frameId);
          this.executionContextToFrame.delete(contextId);
        }
      }
    };

    session.on("Runtime.executionContextCreated", createdHandler);
    session.on("Runtime.executionContextDestroyed", destroyedHandler);
    session.on("Runtime.executionContextsCleared", clearedHandler);

    this.sessionListeners.set(session, [
      {
        event: "Runtime.executionContextCreated",
        handler: createdHandler as (...args: unknown[]) => void,
      },
      {
        event: "Runtime.executionContextDestroyed",
        handler: destroyedHandler as (...args: unknown[]) => void,
      },
      {
        event: "Runtime.executionContextsCleared",
        handler: clearedHandler as (...args: unknown[]) => void,
      },
    ]);

    session.send("Runtime.enable").catch((error) => {
      console.warn(
        "[FrameContextManager] Failed to enable Runtime domain:",
        error
      );
    });
  }
}

const managerCache = new WeakMap<CDPClient, FrameContextManager>();

export function getOrCreateFrameContextManager(
  client: CDPClient
): FrameContextManager {
  let manager = managerCache.get(client);
  if (!manager) {
    manager = new FrameContextManager(client);
    managerCache.set(client, manager);
  }
  return manager;
}
