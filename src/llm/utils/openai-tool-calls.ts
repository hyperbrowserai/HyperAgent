import { parseJsonMaybe } from "@/llm/utils/safe-json";
import { sanitizeProviderOptions } from "@/llm/utils/provider-options";
import { formatUnknownError } from "@/utils";

export interface NormalizedOpenAIToolCall {
  id?: string;
  name: string;
  arguments: unknown;
}

const NO_RESERVED_PROVIDER_OPTION_KEYS: ReadonlySet<string> = new Set();
const MAX_TOOL_CALL_DIAGNOSTIC_CHARS = 2_000;
const MAX_TOOL_CALL_ID_CHARS = 256;
const MAX_TOOL_CALL_NAME_CHARS = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(
  value: unknown,
  maxChars: number
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.slice(0, maxChars);
}

function sanitizeToolArguments(value: unknown): unknown {
  const sanitized = sanitizeProviderOptions(
    { arguments: value },
    NO_RESERVED_PROVIDER_OPTION_KEYS
  );
  return typeof sanitized?.arguments === "undefined"
    ? {}
    : sanitized.arguments;
}

function formatToolCallDiagnostic(value: unknown): string {
  const formatted = formatUnknownError(value);
  if (formatted.length <= MAX_TOOL_CALL_DIAGNOSTIC_CHARS) {
    return formatted;
  }

  const omitted = formatted.length - MAX_TOOL_CALL_DIAGNOSTIC_CHARS;
  return `${formatted.slice(
    0,
    MAX_TOOL_CALL_DIAGNOSTIC_CHARS
  )}... [truncated ${omitted} chars]`;
}

export function normalizeOpenAIToolCalls(
  toolCalls: unknown,
  providerLabel = "OpenAI"
): Array<NormalizedOpenAIToolCall> | undefined {
  if (!Array.isArray(toolCalls)) {
    return undefined;
  }

  return toolCalls.map((toolCall) => {
    if (!isRecord(toolCall)) {
      throw new Error(
        `[LLM][${providerLabel}] Unknown tool call payload: ${formatToolCallDiagnostic(toolCall)}`
      );
    }

    if (toolCall.type === "function") {
      const fn = isRecord(toolCall.function) ? toolCall.function : {};
      return {
        id: normalizeOptionalString(toolCall.id, MAX_TOOL_CALL_ID_CHARS),
        name:
          normalizeOptionalString(fn.name, MAX_TOOL_CALL_NAME_CHARS) ??
          "unknown-tool",
        arguments: sanitizeToolArguments(parseJsonMaybe(fn.arguments)),
      };
    }

    if (toolCall.type === "custom") {
      const custom = isRecord(toolCall.custom) ? toolCall.custom : {};
      return {
        id: normalizeOptionalString(toolCall.id, MAX_TOOL_CALL_ID_CHARS),
        name:
          normalizeOptionalString(custom.name, MAX_TOOL_CALL_NAME_CHARS) ??
          "unknown-tool",
        arguments: sanitizeToolArguments(parseJsonMaybe(custom.input)),
      };
    }

    throw new Error(
      `[LLM][${providerLabel}] Unknown tool call type: ${formatToolCallDiagnostic(toolCall)}`
    );
  });
}
