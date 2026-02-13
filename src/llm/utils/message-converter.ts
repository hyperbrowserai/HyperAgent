import { HyperAgentMessage, HyperAgentContentPart } from "../types";
import { formatUnknownError } from "@/utils";
import type {
  MessageParam,
  ContentBlockParam,
  ImageBlockParam,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages/index";

/**
 * Utility functions for converting between different message formats
 */

function stringifyToolArguments(value: unknown): string {
  if (typeof value === "undefined") {
    return "{}";
  }

  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(value, (_key, candidate: unknown) => {
      if (typeof candidate === "bigint") {
        return `${candidate.toString()}n`;
      }

      if (typeof candidate === "object" && candidate !== null) {
        if (seen.has(candidate)) {
          return "[Circular]";
        }
        seen.add(candidate);
      }

      return candidate;
    });

    return typeof serialized === "string" ? serialized : "{}";
  } catch {
    return "{}";
  }
}

function extractBase64Payload(url: string): string {
  if (!url.startsWith("data:")) {
    return url;
  }

  const commaIndex = url.indexOf(",");
  if (commaIndex < 0) {
    return "";
  }
  return url.slice(commaIndex + 1);
}

function extractTextContent(
  content: string | HyperAgentContentPart[]
): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter((part): part is Extract<HyperAgentContentPart, { type: "text" }> =>
      part.type === "text"
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function normalizeToolName(toolName: string): string {
  const normalized = toolName.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : "unknown-tool";
}

function normalizeOpenAIToolName(toolName: string): string {
  const normalized = normalizeToolName(toolName)
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (normalized.length === 0) {
    return "unknown_tool";
  }

  return normalized.slice(0, 64);
}

function normalizeToolNameForLabel(toolName: string): string {
  const sanitized = normalizeToolName(toolName).replace(/[\[\]\r\n]/g, " ");
  const normalized = sanitized.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : "unknown-tool";
}

function normalizeToolCallId(
  toolCallId: string | undefined,
  toolName: string
): string {
  const normalizedId = toolCallId
    ?.trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  if (normalizedId && normalizedId.length > 0) {
    return normalizedId;
  }
  return normalizeOpenAIToolName(toolName);
}

function buildToolMessageLabel(toolName: string): string {
  return `[Tool ${normalizeToolNameForLabel(toolName)}]`;
}

export function convertToOpenAIMessages(messages: HyperAgentMessage[]) {
  return messages.map((msg) => {
    const openAIMessage: Record<string, unknown> = {
      role: msg.role,
    };

    if (msg.role === "tool") {
      const textContent =
        typeof msg.content === "string"
          ? msg.content
          : extractTextContent(msg.content);
      openAIMessage.content =
        textContent.length > 0 ? textContent : formatUnknownError(msg.content);
      openAIMessage.tool_call_id = normalizeToolCallId(
        msg.toolCallId,
        msg.toolName
      );
      return openAIMessage;
    }

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
          const normalizedToolName = normalizeOpenAIToolName(part.toolName);
          return {
            type: "tool_call",
            id: normalizedToolName,
            function: {
              name: normalizedToolName,
              arguments: stringifyToolArguments(part.arguments),
            },
          };
        }
        return { type: "text", text: formatUnknownError(part) };
      });
    }

    if (msg.role === "assistant" && msg.toolCalls) {
      openAIMessage.tool_calls = msg.toolCalls.map(
        (tc: { id?: string; name: string; arguments: unknown }) => ({
          id: normalizeToolCallId(tc.id, tc.name),
          type: "function",
          function: {
            name: normalizeOpenAIToolName(tc.name),
            arguments: stringifyToolArguments(tc.arguments),
          },
        })
      );
    }

    return openAIMessage;
  });
}

export function convertToAnthropicMessages(messages: HyperAgentMessage[]) {
  const anthropicMessages: MessageParam[] = [];
  const systemMessageParts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      const systemText = extractTextContent(msg.content);
      if (systemText.length > 0) {
        systemMessageParts.push(systemText);
      }
      continue;
    }

    const role = msg.role === "assistant" ? "assistant" : "user";
    const isToolMessage = msg.role === "tool";

    let content: string | ContentBlockParam[];
    if (typeof msg.content === "string") {
      const baseContent = msg.content;
      content = isToolMessage
        ? `${buildToolMessageLabel(msg.toolName)}\n${baseContent}`
        : baseContent;
    } else {
      const blocks: ContentBlockParam[] = [];
      if (isToolMessage) {
        blocks.push({
          type: "text",
          text: buildToolMessageLabel(msg.toolName),
        });
      }
      for (const part of msg.content) {
        if (part.type === "text") {
          const textBlock: TextBlockParam = { type: "text", text: part.text };
          blocks.push(textBlock);
        } else if (part.type === "image") {
          const base64Data = extractBase64Payload(part.url);
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
        } else {
          const textBlock: TextBlockParam = {
            type: "text",
            text: formatUnknownError(part),
          };
          blocks.push(textBlock);
        }
      }
      content = blocks;
    }

    anthropicMessages.push({
      role,
      content,
    });
  }

  const systemMessage =
    systemMessageParts.length > 0
      ? systemMessageParts.join("\n\n")
      : undefined;
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
  const systemInstructionParts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      const systemText = extractTextContent(msg.content);
      if (systemText.length > 0) {
        systemInstructionParts.push(systemText);
      }
      continue;
    }

    const geminiMessage: Record<string, unknown> = {
      role: msg.role === "assistant" ? "model" : "user",
    };
    const isToolMessage = msg.role === "tool";

    if (typeof msg.content === "string") {
      const baseText = msg.content;
      geminiMessage.parts = [
        {
          text: isToolMessage
            ? `${buildToolMessageLabel(msg.toolName)}\n${baseText}`
            : baseText,
        },
      ];
    } else {
      const parts = msg.content.map((part: HyperAgentContentPart) => {
        if (part.type === "text") {
          return { text: part.text };
        } else if (part.type === "image") {
          const base64Data = extractBase64Payload(part.url);
          return {
            inlineData: {
              mimeType: part.mimeType || "image/png",
              data: base64Data,
            },
          };
        }
        return { text: formatUnknownError(part) };
      });
      geminiMessage.parts = isToolMessage
        ? [{ text: buildToolMessageLabel(msg.toolName) }, ...parts]
        : parts;
    }

    geminiMessages.push(geminiMessage);
  }

  const systemInstruction =
    systemInstructionParts.length > 0
      ? systemInstructionParts.join("\n\n")
      : undefined;
  return { messages: geminiMessages, systemInstruction };
}

export function extractImageDataFromUrl(url: string): {
  mimeType: string;
  data: string;
} {
  if (url.startsWith("data:")) {
    const commaIndex = url.indexOf(",");
    const header = commaIndex >= 0 ? url.slice(0, commaIndex) : url;
    const data = commaIndex >= 0 ? url.slice(commaIndex + 1) : "";
    const mimeType = header.match(/data:([^;]+)/)?.[1] || "image/png";
    return { mimeType, data };
  }

  // For non-data URLs, assume PNG
  return { mimeType: "image/png", data: url };
}
