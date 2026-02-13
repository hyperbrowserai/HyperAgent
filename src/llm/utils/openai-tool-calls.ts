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
const MAX_PROVIDER_LABEL_CHARS = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeReadRecordField(
  value: Record<string, unknown>,
  key: string
): unknown {
  try {
    return value[key];
  } catch {
    return undefined;
  }
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

function normalizeProviderLabel(providerLabel: unknown): string {
  const rawLabel =
    typeof providerLabel === "string"
      ? providerLabel
      : formatUnknownError(providerLabel);
  const normalized = rawLabel
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (normalized.length === 0) {
    return "Provider";
  }
  return normalized.slice(0, MAX_PROVIDER_LABEL_CHARS);
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

  const normalizedProviderLabel = normalizeProviderLabel(providerLabel);
  let entries: unknown[];
  try {
    entries = Array.from(toolCalls);
  } catch (error) {
    throw new Error(
      `[LLM][${normalizedProviderLabel}] Unknown tool calls payload: ${formatToolCallDiagnostic(
        error
      )}`
    );
  }

  return entries.map((toolCall) => {
    if (!isRecord(toolCall)) {
      throw new Error(
        `[LLM][${normalizedProviderLabel}] Unknown tool call payload: ${formatToolCallDiagnostic(toolCall)}`
      );
    }

    const toolCallType = safeReadRecordField(toolCall, "type");

    if (toolCallType === "function") {
      const functionValue = safeReadRecordField(toolCall, "function");
      const fn = isRecord(functionValue) ? functionValue : {};
      return {
        id: normalizeOptionalString(
          safeReadRecordField(toolCall, "id"),
          MAX_TOOL_CALL_ID_CHARS
        ),
        name:
          normalizeOptionalString(
            safeReadRecordField(fn, "name"),
            MAX_TOOL_CALL_NAME_CHARS
          ) ??
          "unknown-tool",
        arguments: sanitizeToolArguments(
          parseJsonMaybe(safeReadRecordField(fn, "arguments"))
        ),
      };
    }

    if (toolCallType === "custom") {
      const customValue = safeReadRecordField(toolCall, "custom");
      const custom = isRecord(customValue) ? customValue : {};
      return {
        id: normalizeOptionalString(
          safeReadRecordField(toolCall, "id"),
          MAX_TOOL_CALL_ID_CHARS
        ),
        name:
          normalizeOptionalString(
            safeReadRecordField(custom, "name"),
            MAX_TOOL_CALL_NAME_CHARS
          ) ??
          "unknown-tool",
        arguments: sanitizeToolArguments(
          parseJsonMaybe(safeReadRecordField(custom, "input"))
        ),
      };
    }

    throw new Error(
      `[LLM][${normalizedProviderLabel}] Unknown tool call type: ${formatToolCallDiagnostic(toolCall)}`
    );
  });
}
