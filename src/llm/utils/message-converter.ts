import { HyperAgentMessage, HyperAgentContentPart } from "../types";

/**
 * Utility functions for converting between different message formats
 */

export function convertToOpenAIMessages(messages: HyperAgentMessage[]) {
  return messages.map((msg) => {
    const openAIMessage: Record<string, unknown> = {
      role: msg.role,
    };

    if (typeof msg.content === "string") {
      openAIMessage.content = msg.content;
    } else {
      openAIMessage.content = msg.content.map((part: HyperAgentContentPart) => {
        if (part.type === "text") {
          return { type: "text", text: part.text };
        } else if (part.type === "image") {
          return {
            type: "image_url",
            image_url: { url: part.url },
          };
        } else if (part.type === "tool_call") {
          return {
            type: "tool_call",
            id: part.toolName,
            function: {
              name: part.toolName,
              arguments: JSON.stringify(part.arguments),
            },
          };
        }
        return part;
      });
    }

    if (msg.role === "assistant" && msg.toolCalls) {
      openAIMessage.tool_calls = msg.toolCalls.map(
        (tc: { id?: string; name: string; arguments: unknown }) => ({
          id: tc.id || "",
          type: "function",
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })
      );
    }

    return openAIMessage;
  });
}

export function convertToAnthropicMessages(messages: HyperAgentMessage[]) {
  const anthropicMessages: Record<string, unknown>[] = [];
  let systemMessage: string | undefined;

  for (const msg of messages) {
    if (msg.role === "system") {
      systemMessage = typeof msg.content === "string" ? msg.content : "";
      continue;
    }

    const anthropicMessage: Record<string, unknown> = {
      role: msg.role === "assistant" ? "assistant" : "user",
    };

    if (typeof msg.content === "string") {
      anthropicMessage.content = msg.content;
    } else {
      anthropicMessage.content = msg.content.map(
        (part: HyperAgentContentPart) => {
          if (part.type === "text") {
            return { type: "text", text: part.text };
          } else if (part.type === "image") {
            // Extract base64 data from data URL
            const base64Data = part.url.startsWith("data:")
              ? part.url.split(",")[1]
              : part.url;
            return {
              type: "image",
              source: {
                type: "base64",
                media_type: part.mimeType || "image/png",
                data: base64Data,
              },
            };
          }
          return part;
        }
      );
    }

    anthropicMessages.push(anthropicMessage);
  }

  return { messages: anthropicMessages, system: systemMessage };
}

export function convertToGeminiMessages(messages: HyperAgentMessage[]) {
  const geminiMessages: Record<string, unknown>[] = [];
  let systemInstruction: string | undefined;

  for (const msg of messages) {
    if (msg.role === "system") {
      systemInstruction = typeof msg.content === "string" ? msg.content : "";
      continue;
    }

    const geminiMessage: Record<string, unknown> = {
      role: msg.role === "assistant" ? "model" : "user",
    };

    if (typeof msg.content === "string") {
      geminiMessage.parts = [{ text: msg.content }];
    } else {
      geminiMessage.parts = msg.content.map((part: HyperAgentContentPart) => {
        if (part.type === "text") {
          return { text: part.text };
        } else if (part.type === "image") {
          // Extract base64 data from data URL
          const base64Data = part.url.startsWith("data:")
            ? part.url.split(",")[1]
            : part.url;
          return {
            inlineData: {
              mimeType: part.mimeType || "image/png",
              data: base64Data,
            },
          };
        }
        return part;
      });
    }

    geminiMessages.push(geminiMessage);
  }

  return { messages: geminiMessages, systemInstruction };
}

export function extractImageDataFromUrl(url: string): {
  mimeType: string;
  data: string;
} {
  if (url.startsWith("data:")) {
    const [header, data] = url.split(",");
    const mimeType = header.match(/data:([^;]+)/)?.[1] || "image/png";
    return { mimeType, data };
  }

  // For non-data URLs, assume PNG
  return { mimeType: "image/png", data: url };
}
