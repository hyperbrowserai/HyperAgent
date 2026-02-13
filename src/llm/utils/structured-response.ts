import { z } from "zod";
import { HyperAgentStructuredResult } from "@/llm/types";
import { parseJsonMaybe } from "@/llm/utils/safe-json";
import { formatUnknownError } from "@/utils";

const MAX_STRUCTURED_RAW_TEXT_CHARS = 100_000;

function truncateStructuredRawText(value: string): string {
  if (value.length <= MAX_STRUCTURED_RAW_TEXT_CHARS) {
    return value;
  }
  return `${value.slice(
    0,
    MAX_STRUCTURED_RAW_TEXT_CHARS
  )}... [truncated ${value.length - MAX_STRUCTURED_RAW_TEXT_CHARS} chars]`;
}

function sanitizeStructuredRawText(value: string): string {
  if (value.length === 0) {
    return value;
  }
  return Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code < 32 && code !== 9 && code !== 10) || code === 127
      ? " "
      : char;
  }).join("");
}

export function parseStructuredResponse<TSchema extends z.ZodTypeAny>(
  rawText: unknown,
  schema: TSchema
): HyperAgentStructuredResult<TSchema> {
  if (typeof rawText !== "string") {
    return {
      rawText: truncateStructuredRawText(
        sanitizeStructuredRawText(formatUnknownError(rawText))
      ),
      parsed: null,
    };
  }

  const text = rawText;
  const normalizedRawText = truncateStructuredRawText(text);
  if (text.trim().length === 0) {
    return {
      rawText: normalizedRawText,
      parsed: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = parseJsonMaybe(text);
  } catch {
    return {
      rawText: normalizedRawText,
      parsed: null,
    };
  }
  if (typeof parsed === "string") {
    return {
      rawText: normalizedRawText,
      parsed: null,
    };
  }

  try {
    return {
      rawText: normalizedRawText,
      parsed: schema.parse(parsed),
    };
  } catch {
    return {
      rawText: normalizedRawText,
      parsed: null,
    };
  }
}
