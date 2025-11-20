import { vol } from "memfs";

import { CacheEntry, CacheManager } from "@/utils/cache";
import { sha256, stableStringify } from "@/utils/hash";
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
});
