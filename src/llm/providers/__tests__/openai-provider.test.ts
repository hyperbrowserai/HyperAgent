import type { HyperAgentMessage } from "../../types";
import {
  convertMessagesToResponseInput,
  normalizeResponsesProviderOptions,
  parseResponseOutput,
} from "../openai";

describe("OpenAI provider helpers", () => {
  it("maps messages into Responses API input", () => {
    const messages: HyperAgentMessage[] = [
      {
        role: "system",
        content: "You are helpful.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Show weather" },
          { type: "image", url: "https://example.com/map.png" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Calling" },
          { type: "text", text: " weather tool" },
        ],
        toolCalls: [
          {
            id: "call_123",
            name: "getWeather",
            arguments: { city: "Paris" },
          },
        ],
      },
      {
        role: "tool",
        toolName: "getWeather",
        toolCallId: "call_123",
        content: "Clear skies",
      },
    ];

    const input = convertMessagesToResponseInput(messages);

    expect(input).toMatchObject([
      {
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: "You are helpful." }],
      },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Show weather" },
          {
            type: "input_image",
            image_url: "https://example.com/map.png",
            detail: "auto",
          },
        ],
      },
      {
        type: "function_call",
        call_id: "call_123",
        name: "getWeather",
        arguments: JSON.stringify({ city: "Paris" }),
      },
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "input_text", text: "Calling" },
          { type: "input_text", text: " weather tool" },
        ],
      },
      {
        type: "function_call_output",
        call_id: "call_123",
        output: "Clear skies",
      },
    ]);
  });

  it("normalizes legacy provider options for Responses API", () => {
    const legacyOptions = {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "structured_output",
          schema: { type: "object", properties: {} },
          strict: true,
        },
      },
      max_tokens: 250,
      instructions: "Respond formally",
    } satisfies Record<string, unknown>;

    const normalized = normalizeResponsesProviderOptions(legacyOptions);

    expect(normalized).toEqual({
      instructions: "Respond formally",
      max_output_tokens: 250,
      text: {
        format: {
          type: "json_schema",
          json_schema: {
            name: "structured_output",
            schema: { type: "object", properties: {} },
            strict: true,
          },
        },
      },
    });
  });

  it("extracts assistant content and tool calls from Responses output", () => {
    const response = {
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "Hello!",
            },
          ],
        },
        {
          type: "function_call",
          name: "getWeather",
          call_id: "call_456",
          arguments: JSON.stringify({ city: "Berlin" }),
        },
      ],
      output_text: "Hello!",
    } as unknown as Parameters<typeof parseResponseOutput>[0];

    const result = parseResponseOutput(response);

    expect(result.contentParts).toEqual([{ type: "text", text: "Hello!" }]);
    expect(result.toolCalls).toEqual([
      {
        id: "call_456",
        name: "getWeather",
        arguments: { city: "Berlin" },
      },
    ]);
  });

  it("preserves image outputs", () => {
    const response = {
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_image",
              image_url: {
                url: "https://example.com/generated.png",
                mime_type: "image/png",
              },
            },
          ],
        },
        {
          type: "image_generation_call",
          result: "ZmFrZQ==",
        },
      ],
    } as unknown as Parameters<typeof parseResponseOutput>[0];

    const result = parseResponseOutput(response);

    expect(result.contentParts).toEqual([
      {
        type: "image",
        url: "https://example.com/generated.png",
        mimeType: "image/png",
      },
      {
        type: "image",
        url: "data:image/png;base64,ZmFrZQ==",
        mimeType: "image/png",
      },
    ]);
  });
});
