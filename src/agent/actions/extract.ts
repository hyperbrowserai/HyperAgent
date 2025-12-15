import { z } from "zod";
import { ActionContext, ActionOutput, AgentActionDefinition } from "@/types";
import { parseMarkdown } from "@/utils/html-to-markdown";
import { truncateToTokenLimit } from "@/utils";
import fs from "fs";
import { getCDPClient } from "@/cdp";

export const ExtractAction = z
  .object({
    objective: z.string().describe("The goal of the extraction."),
  })
  .describe(
    "Extract content from the page according to the objective, e.g. product prices, contact information, article text, table data, or specific metadata fields"
  );

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
      const cdpClient = await getCDPClient(ctx.page);
      const cdpSession = await cdpClient.acquireSession("screenshot");
      const screenshot = await cdpSession.send<{ data: string }>(
        "Page.captureScreenshot"
      );

      // Save screenshot to debug dir if exists
      if (ctx.debugDir) {
        fs.writeFileSync(
          `${ctx.debugDir}/extract-screenshot.png`,
          Buffer.from(screenshot.data, "base64")
        );
      }

      // Trim markdown to stay within token limit
      const trimmedMarkdown = truncateToTokenLimit(markdown, ctx.tokenLimit);
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
              text: `Extract the following information from the page according to this objective: "${objective}"\n\nPage content:\n${trimmedMarkdown}\nHere is a screenshot of the page:\n`,
            },
            {
              type: "image",
              url: `data:image/png;base64,${screenshot.data}`,
              mimeType: "image/png",
            },
          ],
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

      if (extractedContent.length === 0) {
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
        message: `Failed to extract content: ${error}`,
      };
    }
  },
  pprintAction: function (params: ExtractActionType): string {
    return `Extract content from page with objective: "${params.objective}"`;
  },
};
