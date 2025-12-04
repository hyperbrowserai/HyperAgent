import { vol } from "memfs";

import { CacheEntry, CacheManager } from "@/utils/cache";
import { sha256, stableStringify } from "@/utils/hash";
import { normalizeInstruction } from "@/utils/instruction-similarity";
import { OperationType } from "@/types/metrics";

jest.mock("node:fs/promises", () => require("memfs").fs.promises);

describe("CacheManager", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("writes and reads cache entries with deterministic keys", async () => {
    const manager = new CacheManager("/cache");
    const parts = {
      opType: "extract" as OperationType,
      url: "https://example.com",
      instruction: "grab data",
      selector: ".item",
      schemaHash: "schema-1",
      domHash: "dom-123",
    };

    const entry: CacheEntry<{ value: string }> = {
      ...parts,
      result: { value: "cached" },
      createdAt: new Date().toISOString(),
      durationMs: 42,
      model: "test-model",
      promptTokens: 10,
      completionTokens: 5,
    };

    manager.write(entry);
    await manager.flushPending();

    const hit = await manager.read<{ value: string }>(parts);
    expect(hit?.result.value).toBe("cached");
    expect(hit?.domHash).toBe(parts.domHash);

    const keyPayload = stableStringify({
      opType: parts.opType,
      url: parts.url,
      instruction: parts.instruction,
      selector: parts.selector,
      schemaHash: parts.schemaHash,
      domHash: parts.domHash,
    });
    const key = sha256(keyPayload);
    const expectedPath = `/cache/${key.slice(0, 2)}/${key}.json`;

    expect(Object.keys(vol.toJSON())).toContain(expectedPath);
  });

  it("returns null when domHash does not match", async () => {
    const manager = new CacheManager("/cache");
    const parts = {
      opType: "act" as OperationType,
      url: "https://example.com/page",
      instruction: "do thing",
      domHash: "hash-a",
    };

    const entry: CacheEntry<string> = {
      ...parts,
      result: "first",
      createdAt: new Date().toISOString(),
      durationMs: 12,
    };

    manager.write(entry);
    await manager.flushPending();

    const miss = await manager.read<string>({ ...parts, domHash: "hash-b" });
    expect(miss).toBeNull();
  });

  describe("semantic instruction matching", () => {
    it("matches semantically similar instructions when useSemanticMatching is true", async () => {
      const manager = new CacheManager("/cache");

      // Write with one phrasing
      const parts1 = {
        opType: "extract" as OperationType,
        url: "https://example.com",
        instruction: "Get product prices",
        domHash: "dom-123",
        useSemanticMatching: true,
      };

      const entry: CacheEntry<string> = {
        ...parts1,
        result: "cached-result",
        createdAt: new Date().toISOString(),
        durationMs: 100,
      };

      manager.write(entry);
      await manager.flushPending();

      // Read with different but semantically similar phrasing
      const parts2 = {
        opType: "extract" as OperationType,
        url: "https://example.com",
        instruction: "Get the prices of products",
        domHash: "dom-123",
        useSemanticMatching: true,
      };

      const hit = await manager.read<string>(parts2);
      expect(hit?.result).toBe("cached-result");
    });

    it("does not match different instructions even with semantic matching", async () => {
      const manager = new CacheManager("/cache");

      const parts1 = {
        opType: "extract" as OperationType,
        url: "https://example.com",
        instruction: "Get prices",
        domHash: "dom-123",
        useSemanticMatching: true,
      };

      const entry: CacheEntry<string> = {
        ...parts1,
        result: "prices-result",
        createdAt: new Date().toISOString(),
        durationMs: 100,
      };

      manager.write(entry);
      await manager.flushPending();

      // Try to read with a different semantic meaning
      const parts2 = {
        opType: "extract" as OperationType,
        url: "https://example.com",
        instruction: "Get reviews",
        domHash: "dom-123",
        useSemanticMatching: true,
      };

      const miss = await manager.read<string>(parts2);
      expect(miss).toBeNull();
    });

    it("stores original instruction when using semantic matching", async () => {
      const manager = new CacheManager("/cache");

      const parts = {
        opType: "extract" as OperationType,
        url: "https://example.com",
        instruction: "Get product prices",
        domHash: "dom-123",
        useSemanticMatching: true,
      };

      const entry: CacheEntry<string> = {
        ...parts,
        result: "cached",
        createdAt: new Date().toISOString(),
        durationMs: 50,
      };

      manager.write(entry);
      await manager.flushPending();

      const hit = await manager.read<string>(parts);
      expect(hit?.originalInstruction).toBe("Get product prices");
    });
  });

  describe("action caching with cacheStrategy", () => {
    it("includes cacheStrategy in key for act operations", async () => {
      const manager = new CacheManager("/cache");

      const partsWithStrategy = {
        opType: "act" as OperationType,
        url: "https://example.com",
        instruction: "Click button",
        domHash: "dom-123",
        cacheStrategy: "result-only" as const,
      };

      const entry: CacheEntry<{ success: boolean }> = {
        ...partsWithStrategy,
        result: { success: true },
        createdAt: new Date().toISOString(),
        durationMs: 50,
      };

      manager.write(entry);
      await manager.flushPending();

      // Same action with same strategy should hit
      const hit = await manager.read<{ success: boolean }>(partsWithStrategy);
      expect(hit?.result.success).toBe(true);

      // Same action with different strategy should miss
      const partsFullStrategy = {
        ...partsWithStrategy,
        cacheStrategy: "full" as const,
      };
      const miss = await manager.read<{ success: boolean }>(partsFullStrategy);
      expect(miss).toBeNull();
    });

    it("caches action results when cacheStrategy is specified", async () => {
      const manager = new CacheManager("/cache");

      const parts = {
        opType: "act" as OperationType,
        url: "https://example.com",
        instruction: "Toggle checkbox",
        domHash: "dom-abc",
        cacheStrategy: "full" as const,
      };

      const entry: CacheEntry<{ toggled: boolean }> = {
        ...parts,
        result: { toggled: true },
        createdAt: new Date().toISOString(),
        durationMs: 30,
      };

      manager.write(entry);
      await manager.flushPending();

      const hit = await manager.read<{ toggled: boolean }>(parts);
      expect(hit?.result.toggled).toBe(true);
    });
  });

  describe("structural hash flag", () => {
    it("includes useStructuralHash flag in entry", async () => {
      const manager = new CacheManager("/cache");

      const parts = {
        opType: "extract" as OperationType,
        url: "https://example.com",
        instruction: "Get data",
        domHash: "structural-hash-123",
        useStructuralHash: true,
      };

      const entry: CacheEntry<string> = {
        ...parts,
        result: "data",
        createdAt: new Date().toISOString(),
        durationMs: 100,
      };

      manager.write(entry);
      await manager.flushPending();

      const hit = await manager.read<string>(parts);
      expect(hit?.useStructuralHash).toBe(true);
    });
  });
});
