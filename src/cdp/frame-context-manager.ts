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
  private initialized = false;
  private initializingPromise: Promise<void> | null = null;

  constructor(private readonly client: CDPClient) {}

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

  toJSON(): { graph: ReturnType<FrameGraph["toJSON"]> } {
    return { graph: this.graph.toJSON() };
  }

  clear(): void {
    this.graph.clear();
    this.sessions.clear();
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initializingPromise) return this.initializingPromise;

    this.initializingPromise = (async () => {
      const rootSession = this.client.rootSession;
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
      if (target && target.targetId) {
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
