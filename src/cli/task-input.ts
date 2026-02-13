import fs from "node:fs";
import { formatUnknownError } from "@/utils";

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

  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw new Error(
      `Task description file "${filePath}" is empty after trimming whitespace.`
    );
  }

  return trimmed;
}
