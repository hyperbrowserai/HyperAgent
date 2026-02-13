import { convertToOpenAIMessages } from "@/llm/utils/message-converter";
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
});
