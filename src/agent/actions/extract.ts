import { z } from "zod";
import { ActionContext, ActionOutput, AgentActionDefinition } from "@/types";
import { parseMarkdown } from "@/utils/html-to-markdown";
import fs from "fs";
import { getCDPClient } from "@/cdp";
import type { HyperAgentContentPart } from "@/llm/types";

export const ExtractAction = z
  .object({
    objective: z.string().describe("The goal of the extraction."),
  })
  .describe(
    "Extract content from the page according to the objective, e.g. product prices, contact information, article text, table data, or specific metadata fields"
  );

export type ExtractActionType = z.infer<typeof ExtractAction>;

const EXTRACT_TRUNCATION_NOTICE = "\n[Content truncated due to token limit]";

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
      console.error(`[extract] Failed to write debug file "${filePath}":`, error);
    }
  }
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  return Math.max(32, available);
}

export const ExtractActionDefinition: AgentActionDefinition = {
  type: "extract" as const,
  actionParams: ExtractAction,
  run: async (
    ctx: ActionContext,
    action: ExtractActionType
  ): Promise<ActionOutput> => {
    try {
      const content = await ctx.page.content();
      const objective = action.objective;
      let markdown: string;
      try {
        markdown = await parseMarkdown(content);
      } catch (error) {
        if (ctx.debug) {
          console.warn(
            "[extract] Markdown conversion failed, falling back to HTML text extraction:",
            formatErrorMessage(error)
          );
        }
        markdown = fallbackMarkdownFromHtml(content);
      }

      // Try to take a screenshot of the page; continue with text-only extraction if unavailable
      let screenshotData: string | null = null;
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
            formatErrorMessage(error)
          );
        }
      }

      // Save screenshot to debug dir if exists
      if (ctx.debugDir && screenshotData) {
        writeDebugFileSafe(
          `${ctx.debugDir}/extract-screenshot.png`,
          Buffer.from(screenshotData, "base64"),
          ctx.debug
        );
      }

      const supportsMultimodal = ctx.llm.getCapabilities().multimodal;
      const includeScreenshot = Boolean(screenshotData && supportsMultimodal);
      if (screenshotData && !supportsMultimodal && ctx.debug) {
        console.warn(
          "[extract] LLM does not support multimodal input; proceeding without screenshot."
        );
      }

      const markdownTokenBudget = computeMarkdownTokenBudget({
        tokenLimit: ctx.tokenLimit,
        objective,
        hasScreenshot: includeScreenshot,
      });
      const trimmedMarkdown = trimMarkdownToTokenLimit(
        markdown,
        markdownTokenBudget
      );
      if (ctx.debugDir) {
        writeDebugFileSafe(
          `${ctx.debugDir}/extract-markdown-content.md`,
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
      // Handle both string and HyperAgentContentPart[] responses
      let extractedContent = "";
      if (typeof response.content === "string") {
        extractedContent = response.content;
      } else if (Array.isArray(response.content)) {
        // Extract text from content parts
        extractedContent = response.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
      }

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
        message: `Failed to extract content: ${formatErrorMessage(error)}`,
      };
    }
  },
  pprintAction: function (params: ExtractActionType): string {
    return `Extract content from page with objective: "${params.objective}"`;
  },
};
