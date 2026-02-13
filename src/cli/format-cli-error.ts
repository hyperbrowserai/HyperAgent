import { formatUnknownError } from "@/utils";

export function formatCliError(error: unknown): string {
  const message = formatUnknownError(error).trim();
  return message.length > 0 ? message : "Unknown CLI error";
}
