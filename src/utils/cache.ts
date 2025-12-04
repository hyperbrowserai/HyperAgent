import fs from "node:fs/promises";
import path from "path";

import { OperationType } from "@/types/metrics";
import { ActionCacheStrategy } from "@/types/agent/types";
import { sha256, stableStringify } from "./hash";
import { normalizeInstruction } from "./instruction-similarity";

export interface CacheKeyParts {
  opType: OperationType;
  url: string;
  instruction: string;
  domHash: string;
  selector?: string;
  schemaHash?: string;
  /**
   * When true, use structural DOM hash for matching (ignores text content changes).
   * The domHash field should contain the structural hash, not the full hash.
   */
  useStructuralHash?: boolean;
  /**
   * When true, normalize instruction before hashing for semantic matching.
   * "Get prices" and "Get the prices" will match.
   */
  useSemanticMatching?: boolean;
  /**
   * Cache strategy for actions
   */
  cacheStrategy?: ActionCacheStrategy;
}

export interface CacheEntry<Result = unknown> extends CacheKeyParts {
  result: Result;
  createdAt: string;
  durationMs: number;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  /** Original instruction before normalization (for debugging) */
  originalInstruction?: string;
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
    // Normalize instruction for semantic matching if enabled
    const instruction = parts.useSemanticMatching
      ? normalizeInstruction(parts.instruction)
      : parts.instruction;

    // Keep ordering deterministic for stable cache keys
    const keyPayload = stableStringify({
      opType: parts.opType,
      url: parts.url,
      instruction,
      selector: parts.selector ?? null,
      schemaHash: parts.schemaHash ?? null,
      domHash: parts.domHash,
      // Include cache strategy in key for actions
      ...(parts.opType === "act" && parts.cacheStrategy
        ? { cacheStrategy: parts.cacheStrategy }
        : {}),
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

    // Store original instruction when using semantic matching for debugging
    const entryToWrite: CacheEntry<Result> = entry.useSemanticMatching
      ? { ...entry, originalInstruction: entry.instruction }
      : entry;

    const writePromise = fs
      .mkdir(path.dirname(filePath), { recursive: true })
      .then(() =>
        fs.writeFile(filePath, JSON.stringify(entryToWrite, null, 2), "utf8")
      )
      .catch((error) => {
        // Best-effort cache; surface details for debug visibility
        console.debug?.(
          "[HyperAgent][cache] Failed to write cache entry:",
          error
        );
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
