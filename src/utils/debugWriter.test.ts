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
});
