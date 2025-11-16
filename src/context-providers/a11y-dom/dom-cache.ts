import type { Page } from "playwright-core";
import type { A11yDOMState } from "./types";

const MAX_CACHE_AGE_MS = 1000;

interface DomCacheEntry {
  state: A11yDOMState;
  timestamp: number;
  version: number;
}

/**
 * Very early skeleton cache for DOM snapshots. The goal is to avoid recomputing
 * the full accessibility tree when nothing has changed. The invalidation hooks
 * (actions, navigations, explicit page events) will be wired in subsequent steps.
 */
class DomSnapshotCache {
  private readonly entries = new WeakMap<Page, DomCacheEntry>();
  private readonly versions = new WeakMap<Page, number>();
  private readonly dirty = new WeakSet<Page>();

  get(page: Page): A11yDOMState | null {
    if (this.dirty.has(page)) {
      return null;
    }
    const entry = this.entries.get(page);
    if (!entry) {
      return null;
    }
    if (Date.now() - entry.timestamp > MAX_CACHE_AGE_MS) {
      this.invalidate(page);
      return null;
    }
    return entry.state;
  }

  set(page: Page, state: A11yDOMState): void {
    const version = (this.versions.get(page) ?? 0) + 1;
    this.versions.set(page, version);
    this.entries.set(page, {
      state,
      timestamp: Date.now(),
      version,
    });
    this.dirty.delete(page);
  }

  invalidate(page: Page): void {
    this.entries.delete(page);
    const version = (this.versions.get(page) ?? 0) + 1;
    this.versions.set(page, version);
    this.dirty.add(page);
  }
}

export const domSnapshotCache = new DomSnapshotCache();

export function markDomSnapshotDirty(page: Page): void {
  domSnapshotCache.invalidate(page);
}
