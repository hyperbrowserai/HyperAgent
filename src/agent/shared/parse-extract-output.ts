import { z } from "zod";
import { formatUnknownError } from "@/utils";

const MAX_EXTRACT_DIAGNOSTIC_CHARS = 400;
const MAX_EXTRACT_PARSE_CHARS = 100_000;

function truncateExtractDiagnostic(value: string): string {
  if (value.length <= MAX_EXTRACT_DIAGNOSTIC_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_EXTRACT_DIAGNOSTIC_CHARS)}... [truncated]`;
}

function ensureStringOutput(output: unknown, taskStatus: unknown): string {
  if (typeof output !== "string" || output.trim().length === 0) {
    throw new Error(
      `Extract failed: Agent did not complete with output. Task status: ${truncateExtractDiagnostic(
        formatUnknownError(taskStatus)
      )}. Check debug output for details.`
    );
  }
  return output;
}

function safeStringify(value: unknown): string {
  return truncateExtractDiagnostic(formatUnknownError(value));
}

function parseStructuredOutput<TSchema extends z.ZodType<unknown>>(
  rawOutput: string,
  outputSchema: TSchema
): z.infer<TSchema> {
  if (rawOutput.length > MAX_EXTRACT_PARSE_CHARS) {
    throw new Error(
      `Extract failed: output exceeds ${MAX_EXTRACT_PARSE_CHARS} characters and cannot be parsed safely.`
    );
  }

  const normalizedOutput = rawOutput.replace(/^\uFEFF/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizedOutput);
  } catch (error) {
    const message = formatUnknownError(error);
    throw new Error(
      `Extract failed: output is not valid JSON (${message}). Raw output: ${truncateExtractDiagnostic(
        rawOutput
      )}`
    );
  }

  const validationResult = outputSchema.safeParse(parsed);
  if (!validationResult.success) {
    const issues = truncateExtractDiagnostic(
      validationResult.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ")
    );
    throw new Error(
      `Extract failed: output does not match schema (${issues}). Parsed output: ${safeStringify(
        parsed
      )}`
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
