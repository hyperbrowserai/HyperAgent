import { z } from "zod";
import { formatUnknownError } from "@/utils";

const MAX_EXTRACT_DIAGNOSTIC_CHARS = 400;
const MAX_EXTRACT_PARSE_CHARS = 100_000;

function sanitizeExtractDiagnostic(value: string): string {
  if (value.length === 0) {
    return value;
  }
  const withoutControlChars = Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code < 32) || code === 127 ? " " : char;
  }).join("");
  return withoutControlChars.replace(/\s+/g, " ").trim();
}

function truncateExtractDiagnostic(value: string): string {
  if (value.length <= MAX_EXTRACT_DIAGNOSTIC_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_EXTRACT_DIAGNOSTIC_CHARS)}... [truncated]`;
}

function formatExtractDiagnostic(value: unknown): string {
  return (
    truncateExtractDiagnostic(
      sanitizeExtractDiagnostic(formatUnknownError(value))
    ) || "unknown error"
  );
}

function ensureStringOutput(output: unknown, taskStatus: unknown): string {
  if (typeof output !== "string" || output.trim().length === 0) {
    throw new Error(
      `Extract failed: Agent did not complete with output. Task status: ${formatExtractDiagnostic(
        taskStatus
      )}. Check debug output for details.`
    );
  }
  return output;
}

function safeStringify(value: unknown): string {
  return formatExtractDiagnostic(value);
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
    const message = formatExtractDiagnostic(error);
    throw new Error(
      `Extract failed: output is not valid JSON (${message}). Raw output: ${truncateExtractDiagnostic(
        sanitizeExtractDiagnostic(rawOutput)
      )}`
    );
  }

  let safeParseResult: unknown;
  try {
    safeParseResult = outputSchema.safeParse(parsed);
  } catch (error) {
    throw new Error(
      `Extract failed: schema validation threw (${formatExtractDiagnostic(
        error
      )}). Parsed output: ${safeStringify(parsed)}`
    );
  }
  if (
    !safeParseResult ||
    typeof safeParseResult !== "object" ||
    !("success" in safeParseResult)
  ) {
    throw new Error(
      `Extract failed: schema validation returned an invalid result shape. Parsed output: ${safeStringify(
        parsed
      )}`
    );
  }
  const validationResult = safeParseResult as {
    success: boolean;
    data?: z.infer<TSchema>;
    error?: { issues?: Array<{ path: PropertyKey[]; message: string }> };
  };

  if (!validationResult.success) {
    let issues: string;
    try {
      issues = truncateExtractDiagnostic(
        (validationResult.error?.issues ?? [])
          .map((issue) => {
            const path = Array.isArray(issue.path)
              ? issue.path
                  .map((segment) =>
                    typeof segment === "string" || typeof segment === "number"
                      ? String(segment)
                      : typeof segment === "symbol"
                        ? segment.toString()
                        : formatExtractDiagnostic(segment)
                  )
                  .join(".")
              : "<root>";
            const normalizedIssueMessage = truncateExtractDiagnostic(
              sanitizeExtractDiagnostic(issue.message)
            );
            return `${path || "<root>"}: ${normalizedIssueMessage}`;
          })
          .join("; ")
      );
    } catch (error) {
      issues = formatExtractDiagnostic(error);
    }
    throw new Error(
      `Extract failed: output does not match schema (${issues}). Parsed output: ${safeStringify(
        parsed
      )}`
    );
  }

  return validationResult.data as z.infer<TSchema>;
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
