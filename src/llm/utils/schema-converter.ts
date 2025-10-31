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

/**
 * Convert Zod schema to Gemini's OpenAPI 3.0 Schema format
 * Gemini uses a subset of OpenAPI 3.0 with custom propertyOrdering field
 */
export function convertToGeminiResponseSchema(
  schema: z.ZodTypeAny
): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, {
    target: "draft-7",
    io: "output",
  });

  // Convert JSON Schema to OpenAPI 3.0 format for Gemini
  return convertJsonSchemaToOpenAPI(jsonSchema);
}

/**
 * Recursively convert JSON Schema to OpenAPI 3.0 format
 * Maps JSON Schema types to Gemini's Type enum values
 */
function convertJsonSchemaToOpenAPI(
  jsonSchema: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Map JSON Schema type to OpenAPI type (uppercase)
  if (jsonSchema.type) {
    const type = jsonSchema.type as string;
    result.type = type.toUpperCase();
  }

  // Handle object properties
  if (jsonSchema.properties && typeof jsonSchema.properties === "object") {
    const convertedProps: Record<string, unknown> = {};
    const properties = jsonSchema.properties as Record<string, unknown>;

    for (const [key, value] of Object.entries(properties)) {
      convertedProps[key] = convertJsonSchemaToOpenAPI(
        value as Record<string, unknown>
      );
    }

    result.properties = convertedProps;

    // Add propertyOrdering for deterministic field order
    result.propertyOrdering = Object.keys(properties);
  }

  // Handle array items
  if (jsonSchema.items) {
    result.items = convertJsonSchemaToOpenAPI(
      jsonSchema.items as Record<string, unknown>
    );
  }

  // Pass through supported fields
  if (jsonSchema.required) result.required = jsonSchema.required;
  if (jsonSchema.description) result.description = jsonSchema.description;
  if (jsonSchema.enum) result.enum = jsonSchema.enum;
  if (jsonSchema.format) result.format = jsonSchema.format;
  if (jsonSchema.minimum !== undefined) result.minimum = jsonSchema.minimum;
  if (jsonSchema.maximum !== undefined) result.maximum = jsonSchema.maximum;
  if (jsonSchema.minItems !== undefined) result.minItems = jsonSchema.minItems;
  if (jsonSchema.maxItems !== undefined) result.maxItems = jsonSchema.maxItems;
  if (jsonSchema.nullable !== undefined) result.nullable = jsonSchema.nullable;

  // Skip JSON Schema specific fields that Gemini doesn't use
  // ($schema, additionalProperties, etc.)

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
