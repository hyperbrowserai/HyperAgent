import { HyperAgentMessage, HyperAgentContentPart } from "../types";
import type {
  MessageParam,
  ContentBlockParam,
  ImageBlockParam,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages/index";

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
  const anthropicMessages: MessageParam[] = [];
  let systemMessage: string | undefined;

  for (const msg of messages) {
    if (msg.role === "system") {
      systemMessage = typeof msg.content === "string" ? msg.content : "";
      continue;
    }

    const role = msg.role === "assistant" ? "assistant" : "user";

    let content: string | ContentBlockParam[];
    if (typeof msg.content === "string") {
      content = msg.content;
    } else {
      const blocks: ContentBlockParam[] = [];
      for (const part of msg.content) {
        if (part.type === "text") {
          const textBlock: TextBlockParam = { type: "text", text: part.text };
          blocks.push(textBlock);
        } else if (part.type === "image") {
          const base64Data = part.url.startsWith("data:")
            ? part.url.split(",")[1]
            : part.url;
          const mediaType = normalizeImageMimeType(part.mimeType);
          const imageBlock: ImageBlockParam = {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: base64Data,
            },
          };
          blocks.push(imageBlock);
        }
      }
      content = blocks;
    }

    anthropicMessages.push({
      role,
      content,
    });
  }

  return { messages: anthropicMessages, system: systemMessage };
}

const ANTHROPIC_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function normalizeImageMimeType(
  mimeType?: string
): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  if (mimeType && ANTHROPIC_IMAGE_MEDIA_TYPES.has(mimeType)) {
    return mimeType as
      | "image/jpeg"
      | "image/png"
      | "image/gif"
      | "image/webp";
  }
  return "image/png";
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
