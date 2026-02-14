import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadTaskDescriptionFromFile,
  normalizeTaskDescription,
} from "@/cli/task-input";

describe("normalizeTaskDescription", () => {
  it("returns trimmed non-empty values", () => {
    expect(
      normalizeTaskDescription("  do the thing  ", "Task description from --command")
    ).toBe("do the thing");
  });

  it("removes UTF-8 BOM prefix before validation", () => {
    expect(
      normalizeTaskDescription(
        "\uFEFFdo the thing",
        "Task description from --command"
      )
    ).toBe("do the thing");
  });

  it("throws readable error for empty values after trim", () => {
    expect(() =>
      normalizeTaskDescription("   ", "Task description from --command")
    ).toThrow(
      "Task description from --command is empty after trimming whitespace. Please provide a non-empty task description."
    );
  });

  it("throws when task description input is not a string", () => {
    expect(() =>
      normalizeTaskDescription(
        42 as unknown as string,
        "Task description from --command"
      )
    ).toThrow(
      "Task description from --command must be a string. Please provide plain text."
    );
  });

  it("sanitizes and truncates oversized source labels in errors", () => {
    const oversizedLabel = `source-${"x".repeat(400)}`;
    expect(() =>
      normalizeTaskDescription(
        42 as unknown as string,
        oversizedLabel
      )
    ).toThrow("[truncated");
    expect(() =>
      normalizeTaskDescription(
        42 as unknown as string,
        oversizedLabel
      )
    ).toThrow("must be a string");
  });

  it("throws when task descriptions exceed the allowed size", () => {
    expect(() =>
      normalizeTaskDescription(
        "x".repeat(20001),
        "Task description from --command"
      )
    ).toThrow(
      "Task description from --command exceeds 20000 characters. Please provide a shorter task description."
    );
  });

  it("throws when task description contains null bytes", () => {
    expect(() =>
      normalizeTaskDescription(
        "hello\u0000world",
        "Task description from --command"
      )
    ).toThrow(
      "Task description from --command appears to be binary or contains null bytes. Please provide plain text."
    );
  });

  it("throws when task description contains unsupported control characters", () => {
    expect(() =>
      normalizeTaskDescription(
        "hello\u0007world",
        "Task description from --command"
      )
    ).toThrow(
      "Task description from --command contains unsupported control characters. Please provide plain text."
    );
  });
});

describe("loadTaskDescriptionFromFile", () => {
  it("throws when task file path is not a non-empty string", async () => {
    await expect(
      loadTaskDescriptionFromFile("" as unknown as string)
    ).rejects.toThrow("Task description file path must be a non-empty string.");
    await expect(
      loadTaskDescriptionFromFile(42 as unknown as string)
    ).rejects.toThrow("Task description file path must be a non-empty string.");
  });

  it("throws when task file path contains control characters", async () => {
    await expect(
      loadTaskDescriptionFromFile("task\nfile.txt")
    ).rejects.toThrow(
      "Task description file path contains unsupported control characters."
    );
  });

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

  it("sanitizes and truncates oversized read-file diagnostics", async () => {
    const statSpy = jest.spyOn(fs.promises, "stat").mockResolvedValue({
      isFile: () => true,
      size: 1,
    } as unknown as fs.Stats);
    const readFileSpy = jest
      .spyOn(fs.promises, "readFile")
      .mockRejectedValue(new Error(`read\u0000\n${"x".repeat(10_000)}`));

    try {
      await loadTaskDescriptionFromFile("/tmp/task-input-test.txt")
        .then(() => {
          throw new Error("expected loadTaskDescriptionFromFile to reject");
        })
        .catch((error) => {
          const message = String(error instanceof Error ? error.message : error);
          expect(message).toContain("[truncated");
          expect(message).not.toContain("\u0000");
          expect(message).not.toContain("\n");
          expect(message.length).toBeLessThan(700);
        });
    } finally {
      statSpy.mockRestore();
      readFileSpy.mockRestore();
    }
  });

  it("throws when file path is not a regular file", async () => {
    const tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "hyperagent-task-input-")
    );

    try {
      await expect(loadTaskDescriptionFromFile(tempDir)).rejects.toThrow(
        `Task description file "${tempDir}" must be a regular text file.`
      );
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws when file exceeds maximum byte size", async () => {
    const tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "hyperagent-task-input-")
    );
    const filePath = path.join(tempDir, "task.txt");
    await fs.promises.writeFile(filePath, "x".repeat(1_000_001), "utf-8");

    try {
      await expect(loadTaskDescriptionFromFile(filePath)).rejects.toThrow(
        `Task description file "${filePath}" exceeds 1000000 bytes. Please provide a smaller text file.`
      );
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("truncates oversized file-path diagnostics", async () => {
    const longPath = `/tmp/${"x".repeat(400)}`;
    await expect(loadTaskDescriptionFromFile(longPath)).rejects.toThrow(
      "[truncated"
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
        `Task description file "${filePath}" is empty after trimming whitespace. Please provide a non-empty task description.`
      );
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });
});
