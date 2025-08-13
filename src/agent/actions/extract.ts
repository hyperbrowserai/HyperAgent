import { z } from "zod";
import { ActionContext, ActionOutput, AgentActionDefinition } from "@/types";
import { parseMarkdown } from "@/utils/html-to-markdown";
import fs from "fs";

export const ExtractAction = z
  .object({
    objective: z.string().describe("The goal of the extraction."),
  })
  .describe(
    "Extract content from the page according to the objective, e.g. product prices, contact information, article text, table data, or specific metadata fields"
  )

export type ExtractActionType = z.infer<typeof ExtractAction>;

export const ExtractActionDefinition: AgentActionDefinition = {
  type: "extract" as const,
  actionParams: ExtractAction,
  run: async (
    ctx: ActionContext,
    action: ExtractActionType
  ): Promise<ActionOutput> => {
    try {
      const content = await ctx.page.content();
      const markdown = await parseMarkdown(content);
      const objective = action.objective;

      // Take a screenshot of the page
      const cdpSession = await ctx.page.context().newCDPSession(ctx.page);
      const screenshot = await cdpSession.send("Page.captureScreenshot");
      cdpSession.detach();

      // Save screenshot to debug dir if exists
      if (ctx.debugDir) {
        fs.writeFileSync(
          `${ctx.debugDir}/extract-screenshot.png`,
          Buffer.from(screenshot.data, "base64")
        );
      }

      // Trim markdown to stay within token limit
      // TODO: this is a hack, we should use a better token counting method
      const avgTokensPerChar = 0.75; // Conservative estimate of tokens per character
      const maxChars = Math.floor(ctx.tokenLimit / avgTokensPerChar);
      const trimmedMarkdown =
        markdown.length > maxChars
          ? markdown.slice(0, maxChars) + "\n[Content truncated due to length]"
          : markdown;
      if (ctx.debugDir) {
        fs.writeFileSync(
          `${ctx.debugDir}/extract-markdown-content.md`,
          trimmedMarkdown
        );
      }

      const response = await ctx.llm.invoke([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Extract the following information from the page according to this objective: "${objective}"\n\nPage content:\n${trimmedMarkdown}\nHere is as screenshot of the page:\n`,
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${screenshot.data}`,
              },
            },
          ],
        },
      ]);
      if (response.content.length === 0) {
        return {
          success: false,
          message: `No content extracted from page.`,
        };
      }
      return {
        success: true,
        message: `Extracted content from page:\n${response.content}`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to extract content: ${error}`,
      };
    }
  },
  pprintAction: function(params: ExtractActionType): string {
    return `Extract content from page with objective: "${params.objective}"`;
  },
};
