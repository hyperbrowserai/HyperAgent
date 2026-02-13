import { z } from "zod";
import { AgentActionDefinition } from "@/types/agent/actions/types";
import { formatUnknownError } from "@/utils";

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

const THOUGHTS_DESCRIPTION =
  "Your reasoning about the current state and what needs to be done next based on the task goal and previous actions.";
const MEMORY_DESCRIPTION =
  "A summary of successful actions completed so far and key state changes (e.g., 'Clicked login button -> login form appeared').";
const MAX_ACTION_DIAGNOSTIC_CHARS = 400;
const MAX_ACTION_DESCRIPTION_CHARS = 4_000;

const FALLBACK_ACTION_PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {},
};

function truncateActionDiagnostic(value: string): string {
  if (value.length <= MAX_ACTION_DIAGNOSTIC_CHARS) {
    return value;
  }
  return `${value.slice(
    0,
    MAX_ACTION_DIAGNOSTIC_CHARS
  )}... [truncated ${value.length - MAX_ACTION_DIAGNOSTIC_CHARS} chars]`;
}

function safeReadActionField(
  action: AgentActionDefinition,
  field: keyof AgentActionDefinition
): unknown {
  try {
    return (action as unknown as Record<string, unknown>)[field];
  } catch (error) {
    return `[Unreadable ${String(field)}: ${truncateActionDiagnostic(
      formatUnknownError(error)
    )}]`;
  }
}

function isUnreadableFieldMarker(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("[Unreadable ");
}

function normalizeActionDescription(value: unknown): string {
  const raw =
    typeof value === "string" ? value : truncateActionDiagnostic(formatUnknownError(value));
  const normalized = Array.from(raw)
    .map((char) => {
      const code = char.charCodeAt(0);
      return (code >= 0 && code < 32) || code === 127 ? " " : char;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const fallback =
    normalized.length > 0
      ? normalized
      : "Generate structured output according to the provided schema";
  if (fallback.length <= MAX_ACTION_DESCRIPTION_CHARS) {
    return fallback;
  }
  return `${fallback.slice(
    0,
    MAX_ACTION_DESCRIPTION_CHARS
  )}... [truncated ${fallback.length - MAX_ACTION_DESCRIPTION_CHARS} chars]`;
}

function convertActionParamsToSchema(
  actionParams: unknown
): Record<string, unknown> {
  try {
    return z.toJSONSchema(actionParams as z.ZodTypeAny, {
      target: "draft-4",
      io: "output",
    });
  } catch {
    return { ...FALLBACK_ACTION_PARAMS_SCHEMA };
  }
}

function safeReadActionParamsDescription(actionParams: unknown): unknown {
  if (!actionParams || typeof actionParams !== "object") {
    return undefined;
  }
  try {
    return (actionParams as Record<string, unknown>).description;
  } catch (error) {
    return `[Unreadable actionParams.description: ${truncateActionDiagnostic(
      formatUnknownError(error)
    )}]`;
  }
}

/**
 * Convert a simple Zod schema to an Anthropic tool (for non-agent use cases)
 * Wraps the schema in a "result" field for consistent parsing
 */
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
 * Create tool choice object for Anthropic
 */
export function createAnthropicToolChoice(
  toolName: string
): Record<string, unknown> {
  return {
    type: "tool",
    name: toolName,
  };
}

export function convertActionsToAnthropicTools(
  actions: AgentActionDefinition[]
): Array<Record<string, unknown>> {
  let actionEntries: AgentActionDefinition[];
  try {
    actionEntries = Array.from(actions);
  } catch (error) {
    throw new Error(
      `[LLM][SchemaConverter] Invalid action definitions payload: ${truncateActionDiagnostic(
        formatUnknownError(error)
      )}`
    );
  }

  return actionEntries.map((action, index) => {
    const actionTypeValue = safeReadActionField(action, "type");
    const actionType =
      typeof actionTypeValue === "string" &&
      actionTypeValue.length > 0 &&
      !isUnreadableFieldMarker(actionTypeValue)
        ? actionTypeValue
        : `unknown_action_${index + 1}`;
    const actionParams = safeReadActionField(action, "actionParams");
    const paramsSchema = convertActionParamsToSchema(actionParams);
    const toolNameValue = safeReadActionField(action, "toolName");
    const toolName =
      typeof toolNameValue === "string" &&
      toolNameValue.length > 0 &&
      !isUnreadableFieldMarker(toolNameValue)
        ? toolNameValue
        : actionType;

    // Create enhanced description with structure example
    const toolDescription = safeReadActionField(action, "toolDescription");
    const actionParamsDescription = safeReadActionParamsDescription(actionParams);
    const baseDescription = normalizeActionDescription(
      typeof toolDescription === "undefined"
        ? actionParamsDescription
        : toolDescription
    );
    const enhancedDescription = `${baseDescription}

IMPORTANT: Response must have this exact structure:
{
  "thoughts": "your reasoning",
  "memory": "summary of actions",
  "action": {
    "type": "${actionType}",
    "params": { ...action parameters here... }
  }
}

Do NOT put params directly at root level. They MUST be nested inside action.params.`;

    return {
      name: toolName,
      description: enhancedDescription,
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          thoughts: {
            type: "string",
            description: THOUGHTS_DESCRIPTION,
          },
          memory: {
            type: "string",
            description: MEMORY_DESCRIPTION,
          },
          action: {
            type: "object",
            description: `The action object. MUST contain 'type' field set to "${actionType}" and 'params' field with the action parameters.`,
            additionalProperties: false,
            properties: {
              type: {
                type: "string",
                const: actionType,
                description: `Must be exactly "${actionType}"`,
              },
              params: {
                ...paramsSchema,
                description: `Parameters for the ${actionType} action. These must be nested here, not at the root level.`,
              },
            },
            required: ["type", "params"],
          },
        },
        required: ["thoughts", "memory", "action"],
      },
    };
  });
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
