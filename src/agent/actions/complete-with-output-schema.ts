import { z } from "zod";
import { ActionContext, ActionOutput, AgentActionDefinition } from "@/types";
import { formatUnknownError } from "@/utils";

const MAX_COMPLETE_OUTPUT_CHARS = 20_000;
const MAX_COMPLETE_DIAGNOSTIC_CHARS = 600;

function formatCompleteDiagnostic(value: unknown): string {
  const raw = typeof value === "string" ? value : formatUnknownError(value);
  const normalized = Array.from(raw, (char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code < 32 && code !== 9 && code !== 10) || code === 127
      ? " "
      : char;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = normalized.length > 0 ? normalized : "unknown error";
  if (fallback.length <= MAX_COMPLETE_DIAGNOSTIC_CHARS) {
    return fallback;
  }
  const omitted = fallback.length - MAX_COMPLETE_DIAGNOSTIC_CHARS;
  return `${fallback.slice(0, MAX_COMPLETE_DIAGNOSTIC_CHARS)}... [truncated ${omitted} chars]`;
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

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(
      value,
      (_key, candidate: unknown) => {
        if (typeof candidate === "bigint") {
          return `${candidate.toString()}n`;
        }
        if (candidate && typeof candidate === "object") {
          if (seen.has(candidate)) {
            return "[Circular]";
          }
          seen.add(candidate);
        }
        return candidate;
      },
      2
    );
    return typeof serialized === "string"
      ? serialized
      : JSON.stringify({ value: serialized }, null, 2);
  } catch (error) {
    return JSON.stringify(
      { __nonSerializable: formatCompleteDiagnostic(error) },
      null,
      2
    );
  }
}

function truncateOutput(value: string): string {
  if (value.length <= MAX_COMPLETE_OUTPUT_CHARS) {
    return value;
  }
  const omitted = value.length - MAX_COMPLETE_OUTPUT_CHARS;
  return `${value.slice(0, MAX_COMPLETE_OUTPUT_CHARS)}\n... [truncated ${omitted} chars]`;
}

export const generateCompleteActionWithOutputDefinition = (
  outputSchema: z.ZodType<unknown>
): AgentActionDefinition => {
  const actionParamsSchema = z
    .object({
      success: z
        .boolean()
        .describe("Whether the task was completed successfully."),
      outputSchema: outputSchema
        .nullable()
        .describe(
          "The output model to return the response in. Given the previous data, try your best to fit the final response into the given schema."
        ),
    })
    .describe(
      "Complete the task. An output schema has been provided to you. Try your best to provide your response so that it fits the output schema provided."
    );

  type CompleteActionWithOutputSchema = z.infer<typeof actionParamsSchema>;

  return {
    type: "complete" as const,
    actionParams: actionParamsSchema,
    run: async (
      ctx: ActionContext,
      actionParams: CompleteActionWithOutputSchema
    ): Promise<ActionOutput> => {
      const success = safeReadRecordField(actionParams, "success") === true;
      const extracted = safeReadRecordField(actionParams, "outputSchema");
      if (success && extracted != null) {
        return {
          success: true,
          message: "The action generated an object",
          extract: extracted as object,
        };
      } else {
        return {
          success: false,
          message:
            "Could not complete task and/or could not extract response into output schema.",
        };
      }
    },
    completeAction: async (params: CompleteActionWithOutputSchema) => {
      const outputSchemaValue = safeReadRecordField(params, "outputSchema");
      return truncateOutput(safeJsonStringify(outputSchemaValue));
    },
  };
};
