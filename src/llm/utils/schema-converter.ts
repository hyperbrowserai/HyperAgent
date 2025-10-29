import { z } from "zod";

/**
 * Utility functions for converting Zod schemas to provider-specific formats
 * Uses Zod v4's native toJSONSchema() method
 */

export function convertToOpenAIJsonSchema(
  schema: z.ZodTypeAny
): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, {
    target: "draft-7",
    io: "output",
  });
  return {
    type: "json_schema",
    json_schema: {
      name: "structured_output",
      strict: true,
      schema: jsonSchema,
    },
  };
}

export function convertToAnthropicTool(
  schema: z.ZodTypeAny
): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, {
    target: "draft-7",
    io: "output",
  });

  return {
    name: "structured_output",
    description: "Generate structured output according to the provided schema",
    input_schema: {
      type: "object",
      properties: {
        result: jsonSchema,
      },
      required: ["result"],
    },
  };
}

export function convertToGeminiResponseSchema(
  schema: z.ZodTypeAny
): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, {
    target: "draft-7",
    io: "output",
  });
  return {
    type: "object",
    properties: {
      result: jsonSchema,
    },
    required: ["result"],
  };
}

export function createAnthropicToolChoice(
  toolName: string
): Record<string, unknown> {
  return {
    type: "tool",
    name: toolName,
  };
}
