import { HyperAgentContentPart } from "@/llm/types";
import { parseJsonMaybe } from "@/llm/utils/safe-json";
import { sanitizeProviderOptions } from "@/llm/utils/provider-options";
import { formatUnknownError } from "@/utils";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NO_RESERVED_PROVIDER_OPTION_KEYS: ReadonlySet<string> = new Set();

function sanitizeToolArguments(value: unknown): unknown {
  const sanitized = sanitizeProviderOptions(
    { arguments: value },
    NO_RESERVED_PROVIDER_OPTION_KEYS
  );
  return typeof sanitized?.arguments === "undefined"
    ? {}
    : sanitized.arguments;
}

function normalizeOpenAICompatibleContentPart(
  part: unknown
): HyperAgentContentPart {
  if (!isRecord(part)) {
    return {
      type: "text",
      text: formatUnknownError(part),
    };
  }

  if (part.type === "text") {
    return {
      type: "text",
      text:
        typeof part.text === "string"
          ? part.text
          : formatUnknownError(part.text),
    };
  }

  if (part.type === "image_url") {
    const imageUrl = isRecord(part.image_url) ? part.image_url : {};
    const normalizedUrl =
      typeof imageUrl.url === "string"
        ? imageUrl.url
        : typeof imageUrl.url === "undefined"
          ? ""
          : formatUnknownError(imageUrl.url);
    return {
      type: "image",
      url: normalizedUrl,
      mimeType: "image/png",
    };
  }

  if (part.type === "tool_call") {
    const fn = isRecord(part.function) ? part.function : {};
    return {
      type: "tool_call",
      toolName: typeof fn.name === "string" ? fn.name : "unknown-tool",
      arguments: sanitizeToolArguments(parseJsonMaybe(fn.arguments)),
    };
  }

  return {
    type: "text",
    text: formatUnknownError(part),
  };
}

export function normalizeOpenAICompatibleContent(
  content: unknown
): string | HyperAgentContentPart[] {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map(normalizeOpenAICompatibleContentPart);
  }

  if (content == null) {
    return "";
  }

  if (typeof content === "object") {
    return formatUnknownError(content);
  }

  return String(content);
}
