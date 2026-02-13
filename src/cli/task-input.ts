import fs from "node:fs";
import { formatUnknownError } from "@/utils";

const MAX_TASK_DESCRIPTION_CHARS = 20_000;

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
