import {
  convertToAnthropicMessages,
  convertToGeminiMessages,
  convertToOpenAIMessages,
  extractImageDataFromUrl,
} from "@/llm/utils/message-converter";
import { HyperAgentMessage } from "@/llm/types";

describe("convertToOpenAIMessages", () => {
  it("serializes circular tool-call arguments without throwing", () => {
    const circular: Record<string, unknown> = { name: "root" };
    circular.self = circular;

    const messages: HyperAgentMessage[] = [
      {
        role: "assistant",
        content: "done",
        toolCalls: [
          {
            id: "call-1",
            name: "tool-1",
            arguments: circular,
          },
        ],
      },
    ];

    const result = convertToOpenAIMessages(messages);
    const serialized = (
      result[0]?.tool_calls as Array<{
        function: { arguments: string };
      }>
    )[0]?.function.arguments;

    expect(serialized).toContain('"self":"[Circular]"');
    expect(() => JSON.parse(serialized)).not.toThrow();
  });

  it("serializes bigint tool arguments in content tool_call parts", () => {
    const messages: HyperAgentMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            toolName: "tool-1",
            arguments: {
              count: BigInt(42),
            },
          },
        ],
      },
    ];

    const result = convertToOpenAIMessages(messages);
    const serialized = (
      result[0]?.content as Array<{ function: { arguments: string } }>
    )[0]?.function.arguments;

    expect(serialized).toContain('"count":"42n"');
    expect(() => JSON.parse(serialized)).not.toThrow();
  });

  it("falls back to empty object string for undefined arguments", () => {
    const messages: HyperAgentMessage[] = [
      {
        role: "assistant",
        content: "done",
        toolCalls: [
          {
            id: "call-1",
            name: "tool-1",
            arguments: undefined,
          },
        ],
      },
    ];

    const result = convertToOpenAIMessages(messages);
    const serialized = (
      result[0]?.tool_calls as Array<{
        function: { arguments: string };
      }>
    )[0]?.function.arguments;

    expect(serialized).toBe("{}");
  });

  it("normalizes unknown content parts to text payloads", () => {
    const circularPart: Record<string, unknown> = { type: "mystery" };
    circularPart.self = circularPart;

    const result = convertToOpenAIMessages([
      {
        role: "assistant",
        content: [circularPart as unknown as never],
      },
    ]);

    expect(result[0]?.content).toEqual([
      {
        type: "text",
        text: '{"type":"mystery","self":"[Circular]"}',
      },
    ]);
  });

  it("normalizes tool-role messages with tool_call_id and text content", () => {
    const result = convertToOpenAIMessages([
      {
        role: "tool",
        toolName: "lookup-user",
        toolCallId: "call-1",
        content: [{ type: "text", text: "tool result payload" }],
      },
    ]);

    expect(result[0]).toEqual({
      role: "tool",
      tool_call_id: "call-1",
      content: "tool result payload",
    });
  });

  it("normalizes tool-call identifiers and names defensively", () => {
    const result = convertToOpenAIMessages([
      {
        role: "tool",
        toolName: "   ",
        toolCallId: "   ",
        content: "tool result payload",
      },
      {
        role: "assistant",
        content: "done",
        toolCalls: [
          {
            id: "call-1",
            name: "   bad\nname   ",
            arguments: {},
          },
        ],
      },
    ]);

    expect(result[0]).toEqual({
      role: "tool",
      tool_call_id: "unknown-tool",
      content: "tool result payload",
    });
    expect((result[1] as { tool_calls?: Array<{ function: { name: string } }> }).tool_calls?.[0]?.function.name).toBe(
      "bad_name"
    );
  });

  it("falls back assistant tool_call ids to normalized tool names", () => {
    const result = convertToOpenAIMessages([
      {
        role: "assistant",
        content: "done",
        toolCalls: [
          {
            id: "   ",
            name: "  weird name !@# ",
            arguments: {},
          },
        ],
      },
    ]);

    const toolCall = (result[0] as { tool_calls?: Array<{ id: string; function: { name: string } }> }).tool_calls?.[0];
    expect(toolCall?.id).toBe("weird_name");
    expect(toolCall?.function.name).toBe("weird_name");
  });

  it("sanitizes OpenAI tool names to supported charset and length", () => {
    const longName = "tool " + "x".repeat(80) + " !@#$";
    const result = convertToOpenAIMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            toolName: longName,
            arguments: {},
          },
        ],
      },
    ]);

    const toolPart = (result[0]?.content as Array<{
      id: string;
      function: { name: string };
    }>)[0];
    expect(toolPart.id.length).toBeLessThanOrEqual(64);
    expect(toolPart.function.name.length).toBeLessThanOrEqual(64);
    expect(toolPart.function.name).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

describe("image payload conversion", () => {
  it("returns empty payload for malformed data URL in Anthropic messages", () => {
    const { messages } = convertToAnthropicMessages([
      {
        role: "user",
        content: [
          {
            type: "image",
            url: "data:image/png;base64",
          },
        ],
      },
    ]);

    expect(messages[0]?.content).toEqual([
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "",
        },
      },
    ]);
  });

  it("returns empty payload for malformed data URL in Gemini messages", () => {
    const { messages } = convertToGeminiMessages([
      {
        role: "user",
        content: [
          {
            type: "image",
            url: "data:image/png;base64",
          },
        ],
      },
    ]);

    expect(messages[0]?.parts).toEqual([
      {
        inlineData: {
          mimeType: "image/png",
          data: "",
        },
      },
    ]);
  });

  it("extractImageDataFromUrl tolerates malformed data URLs", () => {
    expect(extractImageDataFromUrl("data:image/png;base64")).toEqual({
      mimeType: "image/png",
      data: "",
    });
  });
});

describe("system message text extraction", () => {
  it("extracts system text parts for Anthropic conversion", () => {
    const { system } = convertToAnthropicMessages([
      {
        role: "system",
        content: [
          { type: "text", text: "rule one" },
          { type: "image", url: "https://example.com/img.png" },
          { type: "text", text: "rule two" },
        ],
      },
      {
        role: "user",
        content: "hello",
      },
    ]);

    expect(system).toBe("rule one\nrule two");
  });

  it("combines multiple Anthropic system messages in order", () => {
    const { system } = convertToAnthropicMessages([
      {
        role: "system",
        content: "primary system instruction",
      },
      {
        role: "system",
        content: [{ type: "text", text: "secondary instruction" }],
      },
      {
        role: "user",
        content: "hello",
      },
    ]);

    expect(system).toBe("primary system instruction\n\nsecondary instruction");
  });

  it("extracts system text parts for Gemini conversion", () => {
    const { systemInstruction } = convertToGeminiMessages([
      {
        role: "system",
        content: [
          { type: "text", text: "rule one" },
          { type: "tool_call", toolName: "ignored", arguments: {} },
          { type: "text", text: "rule two" },
        ],
      },
      {
        role: "user",
        content: "hello",
      },
    ]);

    expect(systemInstruction).toBe("rule one\nrule two");
  });

  it("combines multiple Gemini system messages in order", () => {
    const { systemInstruction } = convertToGeminiMessages([
      {
        role: "system",
        content: "primary system instruction",
      },
      {
        role: "system",
        content: [{ type: "text", text: "secondary instruction" }],
      },
      {
        role: "user",
        content: "hello",
      },
    ]);

    expect(systemInstruction).toBe(
      "primary system instruction\n\nsecondary instruction"
    );
  });

  it("normalizes unknown Gemini content parts into text blocks", () => {
    const circularPart: Record<string, unknown> = { type: "mystery" };
    circularPart.self = circularPart;

    const { messages } = convertToGeminiMessages([
      {
        role: "user",
        content: [circularPart as unknown as never],
      },
    ]);

    expect(messages[0]?.parts).toEqual([
      {
        text: '{"type":"mystery","self":"[Circular]"}',
      },
    ]);
  });

  it("normalizes unknown Anthropic content parts into text blocks", () => {
    const { messages } = convertToAnthropicMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            toolName: "lookup",
            arguments: { id: "123" },
          },
        ],
      },
    ]);

    expect(messages[0]?.content).toEqual([
      {
        type: "text",
        text: '{"type":"tool_call","toolName":"lookup","arguments":{"id":"123"}}',
      },
    ]);
  });

  it("prefixes Anthropic tool-role messages with tool label", () => {
    const { messages } = convertToAnthropicMessages([
      {
        role: "tool",
        toolName: "lookup-user",
        content: "tool response",
      },
    ]);

    expect(messages[0]).toEqual({
      role: "user",
      content: "[Tool lookup-user]\ntool response",
    });
  });

  it("sanitizes Anthropic tool labels for unsafe characters", () => {
    const { messages } = convertToAnthropicMessages([
      {
        role: "tool",
        toolName: "  weird]\nname  ",
        content: "tool response",
      },
    ]);

    expect(messages[0]).toEqual({
      role: "user",
      content: "[Tool weird name]\ntool response",
    });
  });

  it("prefixes Gemini tool-role messages with tool label", () => {
    const { messages } = convertToGeminiMessages([
      {
        role: "tool",
        toolName: "lookup-user",
        content: "tool response",
      },
    ]);

    expect(messages[0]).toEqual({
      role: "user",
      parts: [{ text: "[Tool lookup-user]\ntool response" }],
    });
  });

  it("sanitizes Gemini tool labels for unsafe characters", () => {
    const { messages } = convertToGeminiMessages([
      {
        role: "tool",
        toolName: "  weird]\nname  ",
        content: "tool response",
      },
    ]);

    expect(messages[0]).toEqual({
      role: "user",
      parts: [{ text: "[Tool weird name]\ntool response" }],
    });
  });
});
