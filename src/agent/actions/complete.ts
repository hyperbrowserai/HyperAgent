import { z } from "zod";
import { ActionOutput, AgentActionDefinition } from "@/types";
import { formatUnknownError } from "@/utils";

const MAX_COMPLETE_TEXT_CHARS = 20_000;

function sanitizeCompleteText(value: string): string {
  if (value.length === 0) {
    return value;
  }
  return Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    if (code === 9 || code === 10) {
      return char;
    }
    return (code >= 0 && code < 32) || code === 127 ? " " : char;
  }).join("");
}

function safeReadRecordField(value: unknown, key: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function normalizeCompleteText(value: unknown, fallback: string): string {
  const raw =
    typeof value === "string"
      ? value
      : value == null
        ? fallback
        : formatUnknownError(value);
  const normalized = sanitizeCompleteText(raw).replace(/\r\n?/g, "\n").trim();
  if (normalized.length === 0) {
    return fallback;
  }
  if (normalized.length <= MAX_COMPLETE_TEXT_CHARS) {
    return normalized;
  }
  const omitted = normalized.length - MAX_COMPLETE_TEXT_CHARS;
  return `${normalized.slice(
    0,
    MAX_COMPLETE_TEXT_CHARS
  )}\n... [truncated ${omitted} chars]`;
}

export const CompleteAction = z
  .object({
    success: z
      .boolean()
      .describe("Whether the task was completed successfully."),
    text: z
      .string()
      .nullable()
      .describe(
        "The text to complete the task with, make this answer the ultimate goal of the task. Be sure to include all the information requested in the task in explicit detail."
      ),
  })
  .describe("Complete the task, this must be the final action in the sequence");

export type CompleteActionType = z.infer<typeof CompleteAction>;

export const CompleteActionDefinition: AgentActionDefinition = {
  type: "complete" as const,
  actionParams: CompleteAction,
  run: async (_ctx, params): Promise<ActionOutput> => {
    const success = safeReadRecordField(params, "success") === true;
    return {
      success,
      message: success ? "Task Complete" : "Task marked as failed",
    };
  },
  completeAction: async (params: CompleteActionType) => {
    return normalizeCompleteText(
      safeReadRecordField(params, "text"),
      "No response text found"
    );
  },
  pprintAction: function (params: CompleteActionType): string {
    return `Complete task with ${params.success ? "success" : "failure"}`;
  },
};
