import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadTaskDescriptionFromFile } from "@/cli/task-input";

describe("loadTaskDescriptionFromFile", () => {
  it("loads and trims task description text", async () => {
    const tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "hyperagent-task-input-")
    );
    const filePath = path.join(tempDir, "task.txt");
    await fs.promises.writeFile(filePath, "  do the thing  \n", "utf-8");

    try {
      await expect(loadTaskDescriptionFromFile(filePath)).resolves.toBe(
        "do the thing"
      );
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws readable error for missing files", async () => {
    await expect(
      loadTaskDescriptionFromFile("/tmp/does-not-exist-task-file.txt")
    ).rejects.toThrow(
      'Failed to read task description file "/tmp/does-not-exist-task-file.txt":'
    );
  });

  it("throws when file content is empty after trimming", async () => {
    const tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "hyperagent-task-input-")
    );
    const filePath = path.join(tempDir, "task.txt");
    await fs.promises.writeFile(filePath, "   \n\t  ", "utf-8");

    try {
      await expect(loadTaskDescriptionFromFile(filePath)).rejects.toThrow(
        `Task description file "${filePath}" is empty after trimming whitespace.`
      );
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });
});
