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

export function normalizeOpenAIToolCalls(
  toolCalls: unknown
): Array<NormalizedOpenAIToolCall> | undefined {
  if (!Array.isArray(toolCalls)) {
    return undefined;
  }

  return toolCalls.map((toolCall) => {
    if (!isRecord(toolCall)) {
      throw new Error(
        `[LLM][OpenAI] Unknown tool call payload: ${formatUnknownError(toolCall)}`
      );
    }

    if (toolCall.type === "function") {
      const fn = isRecord(toolCall.function) ? toolCall.function : {};
      return {
        id: typeof toolCall.id === "string" ? toolCall.id : undefined,
        name: typeof fn.name === "string" ? fn.name : "unknown-tool",
        arguments: parseJsonMaybe(fn.arguments),
      };
    }

    if (toolCall.type === "custom") {
      const custom = isRecord(toolCall.custom) ? toolCall.custom : {};
      return {
        id: typeof toolCall.id === "string" ? toolCall.id : undefined,
        name: typeof custom.name === "string" ? custom.name : "unknown-tool",
        arguments: parseJsonMaybe(custom.input),
      };
    }

    throw new Error(
      `[LLM][OpenAI] Unknown tool call type: ${formatUnknownError(toolCall)}`
    );
  });
}
