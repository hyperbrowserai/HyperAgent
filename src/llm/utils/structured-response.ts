import { z } from "zod";
import { HyperAgentStructuredResult } from "@/llm/types";
import { parseJsonMaybe } from "@/llm/utils/safe-json";

export function parseStructuredResponse<TSchema extends z.ZodTypeAny>(
  rawText: unknown,
  schema: TSchema
): HyperAgentStructuredResult<TSchema> {
  const text = typeof rawText === "string" ? rawText : "";
  if (text.trim().length === 0) {
    return {
      rawText: text,
      parsed: null,
    };
  }

  const parsed = parseJsonMaybe(text);
  if (typeof parsed === "string") {
    return {
      rawText: text,
      parsed: null,
    };
  }

  try {
    return {
      rawText: text,
      parsed: schema.parse(parsed),
    };
  } catch {
    return {
      rawText: text,
      parsed: null,
    };
  }
}
