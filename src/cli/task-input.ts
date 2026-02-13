import fs from "node:fs";
import { formatUnknownError } from "@/utils";

const MAX_TASK_DESCRIPTION_CHARS = 20_000;
const MAX_TASK_FILE_BYTES = 1_000_000;

function hasUnsupportedControlChars(value: string): boolean {
  return Array.from(value).some((char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
  });
}

export function normalizeTaskDescription(
  value: string,
  sourceLabel: string
): string {
  const trimmed = value.replace(/^\uFEFF/, "").trim();
  if (trimmed.includes("\u0000")) {
    throw new Error(
      `${sourceLabel} appears to be binary or contains null bytes. Please provide plain text.`
    );
  }
  if (hasUnsupportedControlChars(trimmed)) {
    throw new Error(
      `${sourceLabel} contains unsupported control characters. Please provide plain text.`
    );
  }
  if (trimmed.length === 0) {
    throw new Error(
      `${sourceLabel} is empty after trimming whitespace. Please provide a non-empty task description.`
    );
  }
  if (trimmed.length > MAX_TASK_DESCRIPTION_CHARS) {
    throw new Error(
      `${sourceLabel} exceeds ${MAX_TASK_DESCRIPTION_CHARS} characters. Please provide a shorter task description.`
    );
  }
  return trimmed;
}

export async function loadTaskDescriptionFromFile(
  filePath: string
): Promise<string> {
  let fileStats: fs.Stats | undefined;
  try {
    fileStats = await fs.promises.stat(filePath);
  } catch {
    // Fall back to readFile error handling for missing/inaccessible paths.
  }

  if (fileStats && !fileStats.isFile()) {
    throw new Error(
      `Task description file "${filePath}" must be a regular text file.`
    );
  }
  if (fileStats && fileStats.size > MAX_TASK_FILE_BYTES) {
    throw new Error(
      `Task description file "${filePath}" exceeds ${MAX_TASK_FILE_BYTES} bytes. Please provide a smaller text file.`
    );
  }

  let content: string;
  try {
    content = await fs.promises.readFile(filePath, "utf-8");
  } catch (error) {
    throw new Error(
      `Failed to read task description file "${filePath}": ${formatUnknownError(error)}`
    );
  }

  return normalizeTaskDescription(
    content,
    `Task description file "${filePath}"`
  );
}
