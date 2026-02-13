import { z } from "zod";
import { ActionContext, ActionOutput, AgentActionDefinition } from "@/types";
import { parseMarkdown } from "@/utils/html-to-markdown";
import fs from "fs";
import { getCDPClient } from "@/cdp";
import type { HyperAgentContentPart } from "@/llm/types";
import { formatUnknownError } from "@/utils";

export const ExtractAction = z
  .object({
    objective: z.string().describe("The goal of the extraction."),
  })
  .describe(
    "Extract content from the page according to the objective, e.g. product prices, contact information, article text, table data, or specific metadata fields"
  );

export type ExtractActionType = z.infer<typeof ExtractAction>;

const EXTRACT_TRUNCATION_NOTICE = "\n[Content truncated due to token limit]";
const MAX_EXTRACT_OBJECTIVE_CHARS = 1_000;
const MAX_EXTRACT_RESPONSE_CHARS = 12_000;
const EXTRACT_RESPONSE_TRUNCATION_NOTICE = "\n[Extraction output truncated]";
const MAX_EXTRACT_HTML_CHARS = 1_000_000;

export function estimateTextTokenCount(text: string): number {
  if (text.trim().length === 0) {
    return 0;
  }
  const wordCount = text.match(/[A-Za-z0-9_]+/g)?.length ?? 0;
  const cjkCount =
    text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)
      ?.length ?? 0;
  const symbolCount = text.match(/[^\sA-Za-z0-9_]/g)?.length ?? 0;
  const characterEstimate = Math.ceil(text.length / 3.8);
  const lexicalEstimate = Math.ceil(
    wordCount * 1.1 + cjkCount + symbolCount * 0.3
  );
  return Math.max(characterEstimate, lexicalEstimate);
}

export function trimMarkdownToTokenLimit(
  markdown: string,
  tokenLimit: number
): string {
  if (estimateTextTokenCount(markdown) <= tokenLimit) {
    return markdown;
  }

  const suffixTokens = estimateTextTokenCount(EXTRACT_TRUNCATION_NOTICE);
  if (tokenLimit <= suffixTokens) {
    return EXTRACT_TRUNCATION_NOTICE;
  }

  const targetPrefixTokens = tokenLimit - suffixTokens;
  let low = 0;
  let high = markdown.length;
  let best = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const prefix = markdown.slice(0, mid);
    if (estimateTextTokenCount(prefix) <= targetPrefixTokens) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return markdown.slice(0, best) + EXTRACT_TRUNCATION_NOTICE;
}

function writeDebugFileSafe(
  filePath: string,
  content: Buffer | string,
  debug?: boolean
): void {
  try {
    fs.writeFileSync(filePath, content);
  } catch (error) {
    if (debug) {
      console.error(
        `[extract] Failed to write debug file "${filePath}": ${formatUnknownError(error)}`
      );
    }
  }
}

function ensureDebugDirSafe(debugDir: string, debug?: boolean): string | null {
  try {
    fs.mkdirSync(debugDir, { recursive: true });
    return debugDir;
  } catch (error) {
    if (debug) {
      console.error(
        `[extract] Failed to prepare debug directory "${debugDir}": ${formatUnknownError(error)}`
      );
    }
    return null;
  }
}

function fallbackMarkdownFromHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function computeMarkdownTokenBudget(params: {
  tokenLimit: number;
  objective: string;
  hasScreenshot: boolean;
}): number {
  const { tokenLimit, objective, hasScreenshot } = params;
  const templateText = hasScreenshot
    ? `Extract the following information from the page according to this objective: "${objective}"\n\nPage content:\n\nHere is a screenshot of the page:\n`
    : `Extract the following information from the page according to this objective: "${objective}"\n\nPage content:\n\nNo screenshot was available. Use the page content to extract the answer.`;
  const templateTokens = estimateTextTokenCount(templateText);
  const available = Math.floor(tokenLimit * 0.9) - templateTokens;
  return Math.max(0, available);
}

function normalizeTokenLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 4000;
  }
  return Math.floor(value);
}

function safeReadRecordField(value: unknown, key: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function normalizeObjective(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_EXTRACT_OBJECTIVE_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_EXTRACT_OBJECTIVE_CHARS)}…`;
}

function normalizeExtractedContent(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= MAX_EXTRACT_RESPONSE_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_EXTRACT_RESPONSE_CHARS)}${EXTRACT_RESPONSE_TRUNCATION_NOTICE}`;
}

function extractTextResponse(content: unknown): string {
  if (typeof content === "string") {
    return normalizeExtractedContent(content);
  }
  if (!Array.isArray(content)) {
    return "";
  }
  let parts: unknown[] = [];
  try {
    parts = Array.from(content);
  } catch {
    return "";
  }

  const textParts: string[] = [];
  for (const part of parts) {
    const type = safeReadRecordField(part, "type");
    if (type !== "text") {
      continue;
    }
    const text = safeReadRecordField(part, "text");
    if (typeof text === "string" && text.length > 0) {
      textParts.push(text);
    }
  }
  return normalizeExtractedContent(textParts.join(""));
}

function supportsMultimodalInput(ctx: ActionContext): boolean {
  try {
    return ctx.llm.getCapabilities().multimodal === true;
  } catch {
    return false;
  }
}

export const ExtractActionDefinition: AgentActionDefinition = {
  type: "extract" as const,
  actionParams: ExtractAction,
  run: async (
    ctx: ActionContext,
    action: ExtractActionType
  ): Promise<ActionOutput> => {
    try {
      const objective = normalizeObjective(
        safeReadRecordField(action, "objective")
      );
      if (objective.length === 0) {
        return {
          success: false,
          message: "Extraction objective cannot be empty.",
        };
      }

      let contentMethod: unknown;
      try {
        contentMethod = ctx.page.content;
      } catch (error) {
        return {
          success: false,
          message: `Failed to extract content: unable to access page content method (${formatUnknownError(
            error
          )})`,
        };
      }
      if (typeof contentMethod !== "function") {
        return {
          success: false,
          message: "Failed to extract content: page content method is unavailable.",
        };
      }

      const rawContent = await contentMethod.call(ctx.page);
      const normalizedHtmlSource =
        typeof rawContent === "string"
          ? rawContent
          : formatUnknownError(rawContent);
      const content = normalizedHtmlSource.slice(0, MAX_EXTRACT_HTML_CHARS);
      const normalizedTokenLimit = normalizeTokenLimit(ctx.tokenLimit);
      const debugDir = ctx.debugDir
        ? ensureDebugDirSafe(ctx.debugDir, ctx.debug)
        : null;
      let markdown: string;
      try {
        markdown = await parseMarkdown(content);
      } catch (error) {
        if (ctx.debug) {
          console.warn(
            "[extract] Markdown conversion failed, falling back to HTML text extraction:",
            formatUnknownError(error)
          );
        }
        markdown = fallbackMarkdownFromHtml(content);
      }
      if (markdown.trim().length === 0) {
        markdown = fallbackMarkdownFromHtml(content);
      }

      const supportsMultimodal = supportsMultimodalInput(ctx);
      if (!supportsMultimodal && ctx.debug) {
        console.warn(
          "[extract] LLM does not support multimodal input; proceeding without screenshot."
        );
      }

      // Try to take a screenshot of the page only for multimodal models; continue with text-only extraction if unavailable
      let screenshotData: string | null = null;
      if (supportsMultimodal) {
        try {
          const cdpClient = await getCDPClient(ctx.page);
          const cdpSession = await cdpClient.acquireSession("screenshot");
          const screenshot = await cdpSession.send<{ data: string }>(
            "Page.captureScreenshot"
          );
          screenshotData = screenshot.data;
        } catch (error) {
          if (ctx.debug) {
            console.warn(
              "[extract] Screenshot capture unavailable, falling back to markdown-only extraction:",
              formatUnknownError(error)
            );
          }
        }
      }

      // Save screenshot to debug dir if exists
      if (debugDir && screenshotData) {
        writeDebugFileSafe(
          `${debugDir}/extract-screenshot.png`,
          Buffer.from(screenshotData, "base64"),
          ctx.debug
        );
      }

      const includeScreenshot = Boolean(screenshotData && supportsMultimodal);

      const markdownTokenBudget = computeMarkdownTokenBudget({
        tokenLimit: normalizedTokenLimit,
        objective,
        hasScreenshot: includeScreenshot,
      });
      const trimmedMarkdown = trimMarkdownToTokenLimit(
        markdown,
        markdownTokenBudget
      );
      if (debugDir) {
        writeDebugFileSafe(
          `${debugDir}/extract-markdown-content.md`,
          trimmedMarkdown,
          ctx.debug
        );
      }

      const textPrompt = includeScreenshot
        ? `Extract the following information from the page according to this objective: "${objective}"\n\nPage content:\n${trimmedMarkdown}\nHere is a screenshot of the page:\n`
        : `Extract the following information from the page according to this objective: "${objective}"\n\nPage content:\n${trimmedMarkdown}\nNo screenshot was available. Use the page content to extract the answer.`;
      const contentParts: HyperAgentContentPart[] = [
        {
          type: "text",
          text: textPrompt,
        },
      ];
      if (includeScreenshot && screenshotData) {
        contentParts.push({
          type: "image",
          url: `data:image/png;base64,${screenshotData}`,
          mimeType: "image/png",
        });
      }

      const response = await ctx.llm.invoke([
        {
          role: "user",
          content: contentParts,
        },
      ]);
      const extractedContent = extractTextResponse(
        safeReadRecordField(response, "content")
      );

      if (extractedContent.trim().length === 0) {
        return {
          success: false,
          message: `No content extracted from page.`,
        };
      }
      return {
        success: true,
        message: `Extracted content from page:\n${extractedContent}`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to extract content: ${formatUnknownError(error)}`,
      };
    }
  },
  pprintAction: function (params: ExtractActionType): string {
    return `Extract content from page with objective: "${params.objective}"`;
  },
};
