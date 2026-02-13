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

  it("sanitizes and truncates oversized directory creation diagnostics", async () => {
    const tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "hyperagent-debug-writer-")
    );
    const mkdirSpy = jest.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw new Error(`mkdir\u0000\n${"x".repeat(10_000)}`);
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
      await writeAiActionDebug(debugData, tempDir)
        .then(() => {
          throw new Error("expected writeAiActionDebug to reject");
        })
        .catch((error) => {
          const message = String(error instanceof Error ? error.message : error);
          expect(message).toContain("[truncated");
          expect(message).not.toContain("\u0000");
          expect(message).not.toContain("\n");
          expect(message.length).toBeLessThan(800);
        });
    } finally {
      mkdirSpy.mockRestore();
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not consume action counter when directory creation fails", async () => {
    const tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "hyperagent-debug-writer-")
    );
    const originalMkdir = fs.mkdirSync;
    let hasThrown = false;
    const mkdirSpy = jest.spyOn(fs, "mkdirSync").mockImplementation(
      (
        targetPath: fs.PathLike,
        options?: fs.Mode | fs.MakeDirectoryOptions | null
      ) => {
        if (!hasThrown) {
          hasThrown = true;
          throw { reason: "mkdir denied once" };
        }
        return originalMkdir(targetPath, options);
      }
    );
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
        "mkdir denied once"
      );
      const debugDir = await writeAiActionDebug(debugData, tempDir);
      expect(debugDir.endsWith("action-0")).toBe(true);
    } finally {
      mkdirSpy.mockRestore();
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("normalizes trap-prone debug payload fields without throwing", async () => {
    const tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "hyperagent-debug-writer-")
    );

    const trappedData = {
      get instruction() {
        throw new Error("instruction trap");
      },
      get url() {
        throw new Error("url trap");
      },
      timestamp: new Date().toISOString(),
      domElementCount: 5,
      domTree: "dom tree",
      llmResponse: {
        get rawText() {
          throw new Error("rawText trap");
        },
        parsed: { ok: true },
      },
      success: true,
    } as unknown as DebugData;

    try {
      const debugDir = await writeAiActionDebug(trappedData, tempDir);
      const metadata = await fs.promises.readFile(
        path.join(debugDir, "metadata.json"),
        "utf-8"
      );
      const llmText = await fs.promises.readFile(
        path.join(debugDir, "llm-response.txt"),
        "utf-8"
      );

      expect(metadata).toContain("unknown instruction");
      expect(metadata).toContain("about:blank");
      expect(llmText).toBe("");
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("ignores non-buffer screenshot payloads and truncates oversized text", async () => {
    const tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "hyperagent-debug-writer-")
    );
    const hugeText = "x".repeat(250_000);
    const debugData = {
      instruction: "click login",
      url: "https://example.com",
      timestamp: new Date().toISOString(),
      domElementCount: 5,
      domTree: hugeText,
      screenshot: "not-a-buffer",
      llmResponse: {
        rawText: hugeText,
        parsed: { ok: true },
      },
      success: true,
    } as unknown as DebugData;

    try {
      const debugDir = await writeAiActionDebug(debugData, tempDir);
      const domTree = await fs.promises.readFile(
        path.join(debugDir, "dom-tree.txt"),
        "utf-8"
      );
      const screenshotPath = path.join(debugDir, "screenshot.png");

      expect(domTree).toContain("[truncated");
      await expect(fs.promises.stat(screenshotPath)).rejects.toThrow();
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("bounds non-serializable debug payload diagnostics", async () => {
    const tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "hyperagent-debug-writer-")
    );
    const trapParsed = {
      toJSON: () => {
        throw new Error(`serialize\u0000\n${"x".repeat(10_000)}`);
      },
    };
    const debugData: DebugData = {
      instruction: "click login",
      url: "https://example.com",
      timestamp: new Date().toISOString(),
      domElementCount: 5,
      domTree: "dom tree",
      llmResponse: {
        rawText: "{}",
        parsed: trapParsed,
      },
      success: true,
    };

    try {
      const debugDir = await writeAiActionDebug(debugData, tempDir);
      const llmResponseJson = await fs.promises.readFile(
        path.join(debugDir, "llm-response.json"),
        "utf-8"
      );

      expect(llmResponseJson).toContain("__nonSerializable");
      expect(llmResponseJson).not.toContain("\u0000");
      expect(llmResponseJson).not.toContain("serialize\u0000");
      expect(llmResponseJson.length).toBeLessThan(900);
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });
});
