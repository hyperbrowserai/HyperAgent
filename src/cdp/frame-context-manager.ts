import type { Protocol } from "devtools-protocol";
import type { CDPSession, CDPClient } from "./types";
import type { FrameRecord } from "./frame-graph";
import { FrameGraph } from "./frame-graph";

interface FrameTreeNode {
  frame: Protocol.Page.Frame;
  childFrames?: FrameTreeNode[];
}

interface UpsertFrameInput
  extends Partial<Omit<FrameRecord, "frameId" | "parentFrameId" | "lastUpdated">> {
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
  private readonly autoAttachedSessions = new Map<
    string,
    { session: CDPSession; frameId: string }
  >();
  private autoAttachEnabled = false;
  private autoAttachSetupPromise: Promise<void> | null = null;
  private autoAttachRootSession: CDPSession | null = null;
  private readonly pageTrackedSessions = new WeakSet<CDPSession>();
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

  getFrameIdByIndex(index: number): string | undefined {
    return this.graph.getFrameIdByIndex(index);
  }

  getFrameByIndex(index: number): FrameRecord | undefined {
    const frameId = this.graph.getFrameIdByIndex(index);
    if (!frameId) return undefined;
    return this.graph.getFrame(frameId);
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

    this.autoAttachedSessions.clear();
    this.autoAttachEnabled = false;
    this.autoAttachRootSession = null;
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initializingPromise) return this.initializingPromise;

    this.initializingPromise = (async () => {
      const rootSession = this.client.rootSession;
      await this.enableAutoAttach(rootSession);
      await this.captureFrameTree(rootSession);
      this.initialized = true;
    })().finally(() => {
      this.initializingPromise = null;
    });

    return this.initializingPromise;
  }

  private async captureFrameTree(session: CDPSession): Promise<void> {
    const [{ frameTree }, { targetInfos }] = await Promise.all([
      session.send<Protocol.Page.GetFrameTreeResponse>("Page.getFrameTree"),
      session.send<Protocol.Target.GetTargetsResponse>("Target.getTargets"),
    ]);
    if (!frameTree) return;

    const targetMap = new Map<string, Protocol.Target.TargetInfo>();
    for (const target of targetInfos ?? []) {
      targetMap.set(target.targetId, target);
    }

    let indexCounter = 0;
    const traverse = async (node: FrameTreeNode, parentFrameId: string | null): Promise<void> => {
      const frameId = node.frame.id;
      const record = this.upsertFrame({
        frameId,
        parentFrameId,
        loaderId: node.frame.loaderId,
        name: node.frame.name,
        url: node.frame.url,
      });

      if (typeof this.graph.getFrameIndex(frameId) === "undefined") {
        this.assignFrameIndex(frameId, indexCounter++);
      }

      this.setFrameSession(frameId, session);

      if (record.parentFrameId !== null) {
        await this.populateFrameOwner(session, frameId);
      }

      const target = this.findTargetForFrame(targetMap, frameId);
      if (target && target.targetId && !this.autoAttachEnabled) {
        await this.attachToTarget(session, target.targetId, frameId);
      }

      for (const child of node.childFrames ?? []) {
        await traverse(child, frameId);
      }
    };

    await traverse(frameTree, frameTree.frame?.parentId ?? null);
  }

  private findTargetForFrame(
    targetMap: Map<string, Protocol.Target.TargetInfo>,
    frameId: string
  ): Protocol.Target.TargetInfo | undefined {
    for (const target of targetMap.values()) {
      const info = target as { frameId?: string };
      if (info.frameId === frameId) {
        return target;
      }
    }
    return undefined;
  }

  private async attachToTarget(
    session: CDPSession,
    targetId: string,
    frameId: string
  ): Promise<void> {
    try {
      const { sessionId } = await session.send<Protocol.Target.AttachToTargetResponse>(
        "Target.attachToTarget",
        { targetId, flatten: true }
      );
      const childSession = await this.client.createSession({
        type: "raw",
        target: { sessionId },
      });
      this.setFrameSession(frameId, childSession);
    } catch (error) {
      console.warn(
        `[FrameContextManager] Failed to attach to target ${targetId} for frame ${frameId}:`,
        error
      );
    }
  }

  private async populateFrameOwner(session: CDPSession, frameId: string): Promise<void> {
    try {
      const owner = await session.send<Protocol.DOM.GetFrameOwnerResponse>("DOM.getFrameOwner", { frameId });
      const record = this.graph.getFrame(frameId);
      if (!record) return;
      this.graph.upsertFrame({ ...record, backendNodeId: owner.backendNodeId ?? record.backendNodeId });
    } catch {}
  }

  async enableAutoAttach(session: CDPSession): Promise<void> {
    if (this.autoAttachEnabled) {
      return;
    }
    if (this.autoAttachSetupPromise) {
      return this.autoAttachSetupPromise;
    }

    this.autoAttachRootSession = session;

    this.autoAttachSetupPromise = (async () => {
      session.on("Target.attachedToTarget", this.handleTargetAttached);
      session.on("Target.detachedFromTarget", this.handleTargetDetached);
      await session.send("Target.setAutoAttach", {
        autoAttach: true,
        flatten: true,
        waitForDebuggerOnStart: false,
      });
      await this.trackPageEvents(session);
      this.autoAttachEnabled = true;
      this.log("[FrameContext] Target auto-attach enabled");
    })().finally(() => {
      this.autoAttachSetupPromise = null;
    });

    return this.autoAttachSetupPromise;
  }

  private handleTargetAttached = async (
    event: Protocol.Target.AttachedToTargetEvent
  ): Promise<void> => {
    const frameId = (event.targetInfo as { frameId?: string }).frameId;
    if (!frameId) {
      return;
    }

    try {
      const session = await this.client.createSession({
        type: "raw",
        target: { sessionId: event.sessionId },
      });

      this.autoAttachedSessions.set(event.sessionId, { session, frameId });
      this.setFrameSession(frameId, session);
      this.graph.upsertFrame({
        frameId,
        parentFrameId: event.targetInfo.openerFrameId ?? null,
        name: event.targetInfo.title,
        url: event.targetInfo.url,
        lastUpdated: Date.now(),
      });

      this.log(
        `[FrameContext] Auto-attached session ${session.id ?? event.sessionId} for frame ${frameId} (${event.targetInfo.url ||
          "n/a"})`
      );
    } catch (error) {
      console.warn(
        `[FrameContext] Failed to auto-attach session for frame ${frameId}:`,
        error
      );
    }
  };

  private handleTargetDetached = async (
    event: Protocol.Target.DetachedFromTargetEvent
  ): Promise<void> => {
    const record = this.autoAttachedSessions.get(event.sessionId);
    if (!record) {
      return;
    }

    this.autoAttachedSessions.delete(event.sessionId);
    const { session, frameId } = record;

    if (this.sessions.get(frameId) === session) {
      this.sessions.delete(frameId);
      this.graph.removeFrame(frameId);
    }

    try {
      await session.detach();
    } catch {
      // ignore
    }

    this.log(
      `[FrameContext] Auto-detached session ${session.id ?? event.sessionId} for frame ${frameId}`
    );
  };

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

    const navigatedHandler = (event: Protocol.Page.FrameNavigatedEvent): void => {
      this.handlePageFrameNavigated(event);
    };

    session.on("Page.frameAttached", attachedHandler);
    session.on("Page.frameDetached", detachedHandler);
    session.on("Page.frameNavigated", navigatedHandler);

    const listeners =
      this.sessionListeners.get(session) ??
      [];
    listeners.push(
      { event: "Page.frameAttached", handler: attachedHandler as (...args: unknown[]) => void },
      { event: "Page.frameDetached", handler: detachedHandler as (...args: unknown[]) => void },
      { event: "Page.frameNavigated", handler: navigatedHandler as (...args: unknown[]) => void }
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
    const rootSession = this.autoAttachRootSession ?? this.client.rootSession;
    this.setFrameSession(frameId, rootSession);
    await this.populateFrameOwner(rootSession, frameId);
    this.log(
      `[FrameContext] Page.frameAttached: frameId=${frameId}, parent=${parentFrameId ?? "root"}`
    );
  }

  private handlePageFrameDetached(event: Protocol.Page.FrameDetachedEvent): void {
    const frameId = event.frameId;
    if (!this.graph.getFrame(frameId)) {
      return;
    }
    this.removeFrame(frameId);
    this.log(`[FrameContext] Page.frameDetached: frameId=${frameId}`);
  }

  private handlePageFrameNavigated(event: Protocol.Page.FrameNavigatedEvent): void {
    const frameId = event.frame.id;
    this.upsertFrame({
      frameId,
      parentFrameId: event.frame.parentId ?? null,
      loaderId: event.frame.loaderId,
      url: event.frame.url,
      name: event.frame.name,
    });
    this.log(`[FrameContext] Page.frameNavigated: frameId=${frameId}, url=${event.frame.url}`);
  }

  private trackRuntimeForSession(session: CDPSession): void {
    if (this.runtimeTrackedSessions.has(session)) {
      return;
    }
    this.runtimeTrackedSessions.add(session);

    const createdHandler = (event: Protocol.Runtime.ExecutionContextCreatedEvent): void => {
      const auxData = event.context
        .auxData as { frameId?: string; type?: string } | undefined;
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

    const destroyedHandler = (event: Protocol.Runtime.ExecutionContextDestroyedEvent): void => {
      const frameId = this.executionContextToFrame.get(event.executionContextId);
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
      console.warn("[FrameContextManager] Failed to enable Runtime domain:", error);
    });
  }
}

const managerCache = new WeakMap<CDPClient, FrameContextManager>();

export function getOrCreateFrameContextManager(client: CDPClient): FrameContextManager {
  let manager = managerCache.get(client);
  if (!manager) {
    manager = new FrameContextManager(client);
    managerCache.set(client, manager);
  }
  return manager;
}
