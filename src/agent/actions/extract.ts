import { z } from "zod";
import { ActionContext, ActionOutput, AgentActionDefinition } from "@/types";
import { parseMarkdown } from "@/utils/html-to-markdown";
import fs from "fs";

export const ExtractAction = z
  .object({
    objective: z.string().describe("The goal of the extraction."),
    description: z.string()
      .regex(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/, "Must be a valid TypeScript identifier")
      .describe("The description of the goal of the extraction."),
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
      const tokenLimit = ctx.tokenLimit;

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
      const avgTokensPerChar = 0.75;  // Conservative estimate of tokens per character
      const maxChars = Math.floor(tokenLimit / avgTokensPerChar);
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

  generateCode: async (ctx: ActionContext, action: ExtractActionType) => {
    const description = action.description;

    return `
  try {
    const content${description} = await ctx.page.content();
    const markdown${description} = await parseMarkdown(content${description});
    const objective${description} = ${action.objective};
    const tokenLimit${description} = ${ctx.tokenLimit};

    // Take a screenshot of the page
    const cdpSession${description} = await ctx.page.context().newCDPSession(ctx.page);
    const screenshot${description} = await cdpSession${description}.send("Page.captureScreenshot");
    cdpSession${description}.detach();


    // Trim markdown to stay within token limit
    // TODO: this is a hack, we should use a better token counting method
    const avgTokensPerChar${description} = 0.75;  // Conservative estimate of tokens per character
    const maxChars${description} = Math.floor(tokenLimit${description} / avgTokensPerChar${description});
    const trimmedMarkdown${description} =
      markdown${description}.length > maxChars${description}
        ? markdown${description}.slice(0, maxChars${description}) + "\n[Content truncated due to length]"
        : markdown${description};

    const response${description} = await ctx.llm.invoke([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: \`Extract the following information from the page according to this objective:"\${objective${description}}"\n\nPage content:\n\${trimmedMarkdown${description}}\nHere is as screenshot of the page:\n\`,
          },
          {
            type: "image_url",
            image_url: {
              url: \`data:image/png;base64,\${screenshot${description}.data}\`,
            },
          },
        ],
      },
    ]);
    if (response${description}.content.length === 0) {
      console.log(\`No content extracted from page.\`);
    }
    console.log(\`Extracted content from page:\n\${response${description}.content}\`);
  } catch (error) {
    console.log(\`Failed to extract content: \${error}\`);
  }
    `;
  },

  pprintAction: function(params: ExtractActionType): string {
    return `Extract content from page with objective: "${params.objective}"`;
  },
};
