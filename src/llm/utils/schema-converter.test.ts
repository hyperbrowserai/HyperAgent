import { z } from "zod";
import {
  convertActionsToAnthropicTools,
  convertToGeminiResponseSchema,
} from "@/llm/utils/schema-converter";
import type { AgentActionDefinition } from "@/types/agent/actions/types";

function createAction(
  overrides: Partial<AgentActionDefinition> = {}
): AgentActionDefinition {
  return {
    type: "lookup",
    toolName: "lookup",
    toolDescription: "Lookup records",
    actionParams: z.object({
      query: z.string(),
    }),
    run: jest.fn(),
    ...overrides,
  } as unknown as AgentActionDefinition;
}

describe("convertActionsToAnthropicTools", () => {
  it("converts action definitions into Anthropic tool schemas", () => {
    const tools = convertActionsToAnthropicTools([createAction()]);
    const tool = tools[0] as Record<string, unknown>;
    const inputSchema = tool.input_schema as Record<string, unknown>;
    const action = (inputSchema.properties as Record<string, unknown>)
      .action as Record<string, unknown>;
    const actionType = (action.properties as Record<string, unknown>)
      .type as Record<string, unknown>;

    expect(tool.name).toBe("lookup");
    expect(actionType.const).toBe("lookup");
    expect(tool.description).toContain("IMPORTANT: Response must have this exact structure");
  });

  it("falls back to permissive params schema when actionParams are unreadable", () => {
    const trappedAction = new Proxy(createAction(), {
      get: (target, prop, receiver) => {
        if (prop === "actionParams") {
          throw new Error("params trap");
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const tools = convertActionsToAnthropicTools([
      trappedAction as unknown as AgentActionDefinition,
    ]);
    const tool = tools[0] as Record<string, unknown>;
    const inputSchema = tool.input_schema as Record<string, unknown>;
    const action = (inputSchema.properties as Record<string, unknown>)
      .action as Record<string, unknown>;
    const params = (action.properties as Record<string, unknown>)
      .params as Record<string, unknown>;

    expect(params.type).toBe("object");
    expect(params.additionalProperties).toBe(true);
  });

  it("falls back to synthesized action names when type/toolName are unreadable", () => {
    const trappedAction = new Proxy(createAction(), {
      get: (target, prop, receiver) => {
        if (prop === "type" || prop === "toolName") {
          throw new Error("name trap");
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const tools = convertActionsToAnthropicTools([
      trappedAction as unknown as AgentActionDefinition,
    ]);
    const tool = tools[0] as Record<string, unknown>;
    const inputSchema = tool.input_schema as Record<string, unknown>;
    const action = (inputSchema.properties as Record<string, unknown>)
      .action as Record<string, unknown>;
    const actionType = (action.properties as Record<string, unknown>)
      .type as Record<string, unknown>;

    expect(tool.name).toBe("unknown_action_1");
    expect(actionType.const).toBe("unknown_action_1");
  });

  it("throws readable diagnostics when action-definition array traversal fails", () => {
    const trappedActions = new Proxy([createAction()], {
      get: (target, prop, receiver) => {
        if (prop === Symbol.iterator) {
          throw new Error("action array trap");
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    expect(() =>
      convertActionsToAnthropicTools(
        trappedActions as unknown as AgentActionDefinition[]
      )
    ).toThrow(
      "[LLM][SchemaConverter] Invalid action definitions payload: action array trap"
    );
  });
});

describe("convertToGeminiResponseSchema", () => {
  it("injects placeholder properties for empty object nodes", () => {
    const schema = z.object({
      metadata: z.object({}),
    });

    const result = convertToGeminiResponseSchema(schema);
    const metadata = (result.properties as Record<string, unknown>)
      .metadata as Record<string, unknown>;

    expect(metadata.type).toBe("OBJECT");
    expect(metadata.propertyOrdering).toEqual(["_placeholder"]);
  });
});
