import fs from "node:fs/promises";
import path from "path";

import { OperationType } from "@/types/metrics";
import { sha256, stableStringify } from "./hash";

export interface CacheKeyParts {
  opType: OperationType;
  url: string;
  instruction: string;
  domHash: string;
  selector?: string;
  schemaHash?: string;
}

export interface CacheEntry<Result = unknown> extends CacheKeyParts {
  result: Result;
  createdAt: string;
  durationMs: number;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
}

export class CacheManager {
  private baseDir?: string;
  private pendingWrites = new Set<Promise<void>>();

  constructor(baseDir?: string) {
    this.baseDir = baseDir;
  }

  public isEnabled(): boolean {
    return !!this.baseDir;
  }

  public setBaseDir(baseDir?: string): void {
    this.baseDir = baseDir;
  }

  private buildKey(parts: CacheKeyParts): string {
    // Keep ordering deterministic for stable cache keys
    const keyPayload = stableStringify({
      opType: parts.opType,
      url: parts.url,
      instruction: parts.instruction,
      selector: parts.selector ?? null,
      schemaHash: parts.schemaHash ?? null,
      domHash: parts.domHash,
    });
    return sha256(keyPayload);
  }

  private getFilePath(key: string): string {
    if (!this.baseDir) {
      throw new Error("Cache directory not configured");
    }
    const bucket = key.substring(0, 2);
    return path.join(this.baseDir, bucket, `${key}.json`);
  }

  public async read<Result = unknown>(
    parts: CacheKeyParts
  ): Promise<CacheEntry<Result> | null> {
    if (!this.baseDir) {
      return null;
    }

    const key = this.buildKey(parts);
    const filePath = this.getFilePath(key);

    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as CacheEntry<Result>;
      if (parsed.domHash !== parts.domHash) {
        return null;
      }
      return parsed;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return null;
      }
      // Best-effort cache read; surface other errors as misses
      return null;
    }
  }

  public write<Result = unknown>(entry: CacheEntry<Result>): void {
    if (!this.baseDir) {
      return;
    }
    const key = this.buildKey(entry);
    const filePath = this.getFilePath(key);

    const writePromise = fs
      .mkdir(path.dirname(filePath), { recursive: true })
      .then(() => fs.writeFile(filePath, JSON.stringify(entry, null, 2), "utf8"))
      .catch(() => {
        // Silent failure - cache is best-effort
      });

    this.track(writePromise);
  }

  public async clear(): Promise<void> {
    if (!this.baseDir) {
      return;
    }
    await this.flushPending();
    await fs.rm(this.baseDir, { recursive: true, force: true }).catch(() => {
      // Best-effort clear
    });
  }

  public async flushPending(): Promise<void> {
    if (this.pendingWrites.size === 0) return;
    const writes = Array.from(this.pendingWrites);
    this.pendingWrites.clear();
    await Promise.allSettled(writes);
  }

  private track(promise: Promise<void>): void {
    this.pendingWrites.add(promise);
    promise.finally(() => this.pendingWrites.delete(promise)).catch(() => {
      // ignore
    });
  }
}
