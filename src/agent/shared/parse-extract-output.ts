import { z } from "zod";
import { formatUnknownError } from "@/utils";

function ensureStringOutput(output: unknown, taskStatus: unknown): string {
  if (typeof output !== "string" || output.trim().length === 0) {
    throw new Error(
      `Extract failed: Agent did not complete with output. Task status: ${String(taskStatus)}. Check debug output for details.`
    );
  }
  return output;
}

function safeStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : String(value);
  } catch {
    return String(value);
  }
}

function parseStructuredOutput<TSchema extends z.ZodType<unknown>>(
  rawOutput: string,
  outputSchema: TSchema
): z.infer<TSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput);
  } catch (error) {
    const message = formatUnknownError(error);
    throw new Error(
      `Extract failed: output is not valid JSON (${message}). Raw output: ${rawOutput.slice(
        0,
        400
      )}`
    );
  }

  const validationResult = outputSchema.safeParse(parsed);
  if (!validationResult.success) {
    const issues = validationResult.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `Extract failed: output does not match schema (${issues}). Parsed output: ${safeStringify(
        parsed
      ).slice(0, 400)}`
    );
  }

  return validationResult.data;
}

export function parseExtractOutput(
  output: unknown,
  taskStatus: unknown
): string;
export function parseExtractOutput<TSchema extends z.ZodType<unknown>>(
  output: unknown,
  taskStatus: unknown,
  outputSchema: TSchema
): z.infer<TSchema>;
export function parseExtractOutput<TSchema extends z.ZodType<unknown>>(
  output: unknown,
  taskStatus: unknown,
  outputSchema?: TSchema
): string | z.infer<TSchema> {
  const rawOutput = ensureStringOutput(output, taskStatus);
  if (!outputSchema) {
    return rawOutput;
  }
  return parseStructuredOutput(rawOutput, outputSchema);
}
