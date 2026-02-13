import fs from "node:fs";
import { formatUnknownError } from "@/utils";

export function normalizeTaskDescription(
  value: string,
  sourceLabel: string
): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(
      `${sourceLabel} is empty after trimming whitespace. Please provide a non-empty task description.`
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
