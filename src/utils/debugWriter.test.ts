import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resetDebugSession,
  writeAiActionDebug,
  type DebugData,
} from "@/utils/debugWriter";

describe("writeAiActionDebug", () => {
  beforeEach(() => {
    resetDebugSession();
  });

  it("serializes circular and bigint payloads without throwing", async () => {
    const tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "hyperagent-debug-writer-")
    );
    const circular: { self?: unknown } = {};
    circular.self = circular;

    const debugData: DebugData = {
      instruction: "click login",
      url: "https://example.com",
      timestamp: new Date().toISOString(),
      domElementCount: 5,
      domTree: "dom tree",
      llmResponse: {
        rawText: "{}",
        parsed: circular,
      },
      foundElement: {
        elementId: "0-1",
        method: "click",
        arguments: [1n],
      },
      success: true,
    };

    try {
      const debugDir = await writeAiActionDebug(debugData, tempDir);
      const llmResponseJson = await fs.promises.readFile(
        path.join(debugDir, "llm-response.json"),
        "utf-8"
      );
      const foundElementJson = await fs.promises.readFile(
        path.join(debugDir, "found-element.json"),
        "utf-8"
      );

      expect(llmResponseJson).toContain('"[Circular]"');
      expect(foundElementJson).toContain('"1n"');
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("continues writing debug artifacts when one file write fails", async () => {
    const tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "hyperagent-debug-writer-")
    );
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const originalWrite = fs.writeFileSync;
    let hasThrown = false;
    const writeSpy = jest.spyOn(fs, "writeFileSync").mockImplementation(
      (
        filePath: fs.PathOrFileDescriptor,
        data: string | NodeJS.ArrayBufferView,
        options?: fs.WriteFileOptions
      ) => {
        if (!hasThrown && String(filePath).endsWith("metadata.json")) {
          hasThrown = true;
          throw { reason: "disk once failure" };
        }
        return originalWrite(filePath, data, options);
      }
    );

    const debugData: DebugData = {
      instruction: "click login",
      url: "https://example.com",
      timestamp: new Date().toISOString(),
      domElementCount: 5,
      domTree: "dom tree",
      llmResponse: {
        rawText: "{}",
        parsed: { ok: true },
      },
      success: true,
    };

    try {
      const debugDir = await writeAiActionDebug(debugData, tempDir);
      const domTree = await fs.promises.readFile(
        path.join(debugDir, "dom-tree.txt"),
        "utf-8"
      );
      const llmText = await fs.promises.readFile(
        path.join(debugDir, "llm-response.txt"),
        "utf-8"
      );

      expect(domTree).toBe("dom tree");
      expect(llmText).toBe("{}");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[debugWriter] Failed to write")
      );
    } finally {
      writeSpy.mockRestore();
      warnSpy.mockRestore();
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws readable error when debug directory creation fails", async () => {
    const tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "hyperagent-debug-writer-")
    );
    const mkdirSpy = jest.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw { reason: "mkdir denied" };
    });
    const debugData: DebugData = {
      instruction: "click login",
      url: "https://example.com",
      timestamp: new Date().toISOString(),
      domElementCount: 5,
      domTree: "dom tree",
      success: true,
    };

    try {
      await expect(writeAiActionDebug(debugData, tempDir)).rejects.toThrow(
        '[debugWriter] Failed to create debug directory'
      );
      await expect(writeAiActionDebug(debugData, tempDir)).rejects.toThrow(
        '{"reason":"mkdir denied"}'
      );
    } finally {
      mkdirSpy.mockRestore();
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });
});
