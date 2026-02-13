import { formatUnknownError } from "@/utils";

const MAX_CLI_ERROR_CHARS = 2_000;

function stripControlChars(value: string): string {
  return Array.from(value)
    .map((char) => {
      const code = char.charCodeAt(0);
      return (code >= 0 && code < 32) || code === 127 ? " " : char;
    })
    .join("");
}

function truncateCliError(value: string): string {
  if (value.length <= MAX_CLI_ERROR_CHARS) {
    return value;
  }
  return `${value.slice(
    0,
    MAX_CLI_ERROR_CHARS
  )}... [truncated ${value.length - MAX_CLI_ERROR_CHARS} chars]`;
}

export function formatCliError(error: unknown): string {
  const normalized = stripControlChars(formatUnknownError(error))
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length === 0) {
    return "Unknown CLI error";
  }
  return truncateCliError(normalized);
}
