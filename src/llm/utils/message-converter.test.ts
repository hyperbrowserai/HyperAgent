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
});
