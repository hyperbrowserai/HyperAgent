import { parseJsonMaybe } from "@/llm/utils/safe-json";
import { formatUnknownError } from "@/utils";

export interface NormalizedOpenAIToolCall {
  id?: string;
  name: string;
  arguments: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
        `[LLM][${providerLabel}] Unknown tool call payload: ${formatUnknownError(toolCall)}`
      );
    }

    if (toolCall.type === "function") {
      const fn = isRecord(toolCall.function) ? toolCall.function : {};
      return {
        id: normalizeOptionalString(toolCall.id),
        name: normalizeOptionalString(fn.name) ?? "unknown-tool",
        arguments: parseJsonMaybe(fn.arguments),
      };
    }

    if (toolCall.type === "custom") {
      const custom = isRecord(toolCall.custom) ? toolCall.custom : {};
      return {
        id: normalizeOptionalString(toolCall.id),
        name: normalizeOptionalString(custom.name) ?? "unknown-tool",
        arguments: parseJsonMaybe(custom.input),
      };
    }

    throw new Error(
      `[LLM][${providerLabel}] Unknown tool call type: ${formatUnknownError(toolCall)}`
    );
  });
}
