import type { EncodedId } from "@/context-providers/a11y-dom/types";

export interface FrameRecord {
  frameId: string;
  parentFrameId: string | null;
  loaderId?: string;
  name?: string;
  url?: string;
  sessionId?: string;
  executionContextId?: number;
  isolatedWorldId?: number;
  backendNodeId?: number;
  iframeEncodedId?: EncodedId;
  lastUpdated: number;
}

export class FrameGraph {
  private readonly frames = new Map<string, FrameRecord>();
  private readonly children = new Map<string | null, string[]>();
  private readonly frameIndexMap = new Map<number, string>();
  private readonly frameIdToIndex = new Map<string, number>();

  getFrame(frameId: string): FrameRecord | undefined {
    return this.frames.get(frameId);
  }

  getFrameIndex(frameId: string): number | undefined {
    return this.frameIdToIndex.get(frameId);
  }

  getFrameIdByIndex(index: number): string | undefined {
    return this.frameIndexMap.get(index);
  }

  getChildren(parentFrameId: string | null): string[] {
    return Array.from(this.children.get(parentFrameId) ?? []);
  }

  getAllFrames(): FrameRecord[] {
    return Array.from(this.frames.values());
  }

  upsertFrame(record: Omit<FrameRecord, "lastUpdated"> & { lastUpdated?: number }): FrameRecord {
    const existing = this.frames.get(record.frameId);
    const lastUpdated = record.lastUpdated ?? Date.now();
    const merged: FrameRecord = {
      frameId: record.frameId,
      parentFrameId: record.parentFrameId ?? null,
      loaderId: record.loaderId ?? existing?.loaderId,
      name: record.name ?? existing?.name,
      url: record.url ?? existing?.url,
      sessionId: record.sessionId ?? existing?.sessionId,
      executionContextId: record.executionContextId ?? existing?.executionContextId,
      isolatedWorldId: record.isolatedWorldId ?? existing?.isolatedWorldId,
      backendNodeId: record.backendNodeId ?? existing?.backendNodeId,
      iframeEncodedId: record.iframeEncodedId ?? existing?.iframeEncodedId,
      lastUpdated,
    };

    this.frames.set(merged.frameId, merged);
    this.updateParentRelation(merged.frameId, existing?.parentFrameId ?? null, merged.parentFrameId);
    return merged;
  }

  removeFrame(frameId: string): void {
    const record = this.frames.get(frameId);
    if (!record) return;
    this.frames.delete(frameId);
    const parentChildren = this.children.get(record.parentFrameId ?? null);
    if (parentChildren) {
      this.children.set(
        record.parentFrameId ?? null,
        parentChildren.filter((id) => id !== frameId)
      );
    }
    const index = this.frameIdToIndex.get(frameId);
    if (typeof index === "number") {
      this.frameIndexMap.delete(index);
      this.frameIdToIndex.delete(frameId);
    }
    const childIds = this.children.get(frameId) ?? [];
    this.children.delete(frameId);
    childIds.forEach((childId) => this.removeFrame(childId));
  }

  assignFrameIndex(frameId: string, index: number): void {
    this.frameIndexMap.set(index, frameId);
    this.frameIdToIndex.set(frameId, index);
  }

  toJSON(): {
    frames: FrameRecord[];
    frameIndexMap: Record<number, string>;
  } {
    return {
      frames: Array.from(this.frames.values()),
      frameIndexMap: Object.fromEntries(this.frameIndexMap),
    };
  }

  clear(): void {
    this.frames.clear();
    this.children.clear();
    this.frameIndexMap.clear();
    this.frameIdToIndex.clear();
  }

  private updateParentRelation(
    frameId: string,
    prevParent: string | null,
    nextParent: string | null
  ): void {
    if (prevParent === nextParent) return;

    const prevChildren = this.children.get(prevParent) ?? [];
    if (prevChildren.length) {
      this.children.set(
        prevParent,
        prevChildren.filter((id) => id !== frameId)
      );
    }

    const list = this.children.get(nextParent) ?? [];
    if (!list.includes(frameId)) {
      list.push(frameId);
    }
    this.children.set(nextParent, list);
  }
}
