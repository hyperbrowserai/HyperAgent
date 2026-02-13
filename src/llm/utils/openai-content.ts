import { HyperAgentContentPart } from "@/llm/types";
import { parseJsonMaybe } from "@/llm/utils/safe-json";
import { sanitizeProviderOptions } from "@/llm/utils/provider-options";
import { formatUnknownError } from "@/utils";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_TOOL_NAME_CHARS = 256;
const MAX_IMAGE_URL_CHARS = 4_000;
const MAX_CONTENT_DIAGNOSTIC_CHARS = 2_000;

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

const NO_RESERVED_PROVIDER_OPTION_KEYS: ReadonlySet<string> = new Set();

function truncateContentDiagnostic(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}... [truncated ${omitted} chars]`;
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

function normalizeImageUrl(value: unknown): string {
  if (typeof value === "string") {
    const normalized = value
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .trim()
      .replace(/\s+/g, " ");
    return truncateContentDiagnostic(normalized, MAX_IMAGE_URL_CHARS);
  }
  if (typeof value === "undefined") {
    return "";
  }
  return truncateContentDiagnostic(
    formatUnknownError(value),
    MAX_IMAGE_URL_CHARS
  );
}

function normalizeContentDiagnostic(value: unknown): string {
  return truncateContentDiagnostic(
    formatUnknownError(value),
    MAX_CONTENT_DIAGNOSTIC_CHARS
  );
}

function normalizeOpenAICompatibleContentPart(
  part: unknown
): HyperAgentContentPart {
  if (!isRecord(part)) {
    return {
      type: "text",
      text: normalizeContentDiagnostic(part),
    };
  }

  const partType = safeReadRecordField(part, "type");

  if (partType === "text") {
    const textValue = safeReadRecordField(part, "text");
    return {
      type: "text",
      text:
        typeof textValue === "string"
          ? textValue
          : normalizeContentDiagnostic(textValue),
    };
  }

  if (partType === "image_url") {
    const imageUrlValue = safeReadRecordField(part, "image_url");
    const imageUrl = isRecord(imageUrlValue) ? imageUrlValue : {};
    return {
      type: "image",
      url: normalizeImageUrl(safeReadRecordField(imageUrl, "url")),
      mimeType: "image/png",
    };
  }

  if (partType === "tool_call") {
    const functionValue = safeReadRecordField(part, "function");
    const fn = isRecord(functionValue) ? functionValue : {};
    return {
      type: "tool_call",
      toolName:
        normalizeOptionalString(
          safeReadRecordField(fn, "name"),
          MAX_TOOL_NAME_CHARS
        ) ?? "unknown-tool",
      arguments: sanitizeToolArguments(
        parseJsonMaybe(safeReadRecordField(fn, "arguments"))
      ),
    };
  }

  return {
    type: "text",
    text: normalizeContentDiagnostic(part),
  };
}

function isSingleContentPartShape(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const type = safeReadRecordField(value, "type");
  if (typeof type !== "string") {
    return false;
  }
  return (
    type === "text" ||
    type === "image_url" ||
    type === "tool_call"
  );
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

export function normalizeOpenAICompatibleContent(
  content: unknown
): string | HyperAgentContentPart[] {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    try {
      return Array.from(content).map(normalizeOpenAICompatibleContentPart);
    } catch (error) {
      return normalizeContentDiagnostic(error);
    }
  }

  if (content == null) {
    return "";
  }

  if (isSingleContentPartShape(content)) {
    return [normalizeOpenAICompatibleContentPart(content)];
  }

  if (typeof content === "object") {
    return normalizeContentDiagnostic(content);
  }

  return String(content);
}
