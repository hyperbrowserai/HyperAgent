import { z } from "zod";

/**
 * Utility functions for converting Zod schemas to provider-specific formats
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

/**
 * Convert Zod schema to Gemini's OpenAPI 3.0 Schema format
 * Gemini requires: uppercase types, propertyOrdering, no empty objects
 */
export function convertToGeminiResponseSchema(
  schema: z.ZodTypeAny
): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, {
    target: "draft-7",
    io: "output",
  });

  return convertJsonSchemaToGemini(jsonSchema);
}

/**
 * Recursively convert JSON Schema to Gemini's OpenAPI 3.0 format
 */
function convertJsonSchemaToGemini(
  jsonSchema: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Map JSON Schema type to Gemini type (uppercase)
  if (jsonSchema.type) {
    const type = jsonSchema.type as string;
    result.type = type.toUpperCase();
  }

  // Handle object properties
  if (jsonSchema.properties && typeof jsonSchema.properties === "object") {
    const properties = jsonSchema.properties as Record<string, unknown>;

    // If properties is empty, Gemini rejects it - skip the entire object by returning null placeholder
    if (Object.keys(properties).length === 0) {
      return {
        type: "OBJECT",
        properties: {
          _placeholder: {
            type: "STRING",
            description: "Empty object placeholder",
            nullable: true,
          },
        },
        propertyOrdering: ["_placeholder"],
        required: [],
      };
    }

    const convertedProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      convertedProps[key] = convertJsonSchemaToGemini(
        value as Record<string, unknown>
      );
    }

    result.properties = convertedProps;
    result.propertyOrdering = Object.keys(properties);
  }

  // Handle array items
  if (jsonSchema.items) {
    result.items = convertJsonSchemaToGemini(
      jsonSchema.items as Record<string, unknown>
    );
  }

  // Handle union types (anyOf, oneOf)
  if (jsonSchema.anyOf && Array.isArray(jsonSchema.anyOf)) {
    result.anyOf = (jsonSchema.anyOf as Array<Record<string, unknown>>).map(
      (schema) => convertJsonSchemaToGemini(schema)
    );
  }

  if (jsonSchema.oneOf && Array.isArray(jsonSchema.oneOf)) {
    result.oneOf = (jsonSchema.oneOf as Array<Record<string, unknown>>).map(
      (schema) => convertJsonSchemaToGemini(schema)
    );
  }

  // Pass through supported fields
  if (jsonSchema.required) result.required = jsonSchema.required;
  if (jsonSchema.description) result.description = jsonSchema.description;
  if (jsonSchema.enum) result.enum = jsonSchema.enum;

  // Convert JSON Schema "const" to "enum" for Gemini
  if (jsonSchema.const !== undefined) {
    result.enum = [jsonSchema.const];
  }

  if (jsonSchema.format) result.format = jsonSchema.format;
  if (jsonSchema.minimum !== undefined) result.minimum = jsonSchema.minimum;
  if (jsonSchema.maximum !== undefined) result.maximum = jsonSchema.maximum;
  if (jsonSchema.minItems !== undefined) result.minItems = jsonSchema.minItems;
  if (jsonSchema.maxItems !== undefined) result.maxItems = jsonSchema.maxItems;
  if (jsonSchema.nullable !== undefined) result.nullable = jsonSchema.nullable;

  return result;
}

export function createAnthropicToolChoice(
  toolName: string
): Record<string, unknown> {
  return {
    type: "tool",
    name: toolName,
  };
}
