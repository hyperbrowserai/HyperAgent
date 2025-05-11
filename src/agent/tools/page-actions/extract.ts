import { z } from "zod";
import { parseMarkdown } from "@/utils/html-to-markdown";
import { Page } from "playwright";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

export interface ExtractOptions<
  T extends z.AnyZodObject | undefined = z.AnyZodObject,
> {
  schema?: T;
  task?: string;
  page: Page;
  llm: BaseChatModel;
  tokenLimit?: number;
}

export async function PageExtractFn<
  T extends z.AnyZodObject | undefined = z.AnyZodObject,
>({
  schema,
  task,
  page,
  llm,
  tokenLimit = 4000,
}: ExtractOptions<T>): Promise<T extends z.AnyZodObject ? z.infer<T> : string> {
  if (!schema && !task) {
    throw new Error("Either schema or task must be provided");
  }

  // Get page content and convert to markdown
  const content = await page.content();
  const markdown = await parseMarkdown(content);

  // Get page metadata
  const metadata = await page.evaluate(() => {
    const meta = {
      title: document.title,
      description:
        document
          .querySelector('meta[name="description"]')
          ?.getAttribute("content") || "",
      keywords:
        document
          .querySelector('meta[name="keywords"]')
          ?.getAttribute("content") || "",
      ogTitle:
        document
          .querySelector('meta[property="og:title"]')
          ?.getAttribute("content") || "",
      ogDescription:
        document
          .querySelector('meta[property="og:description"]')
          ?.getAttribute("content") || "",
      ogImage:
        document
          .querySelector('meta[property="og:image"]')
          ?.getAttribute("content") || "",
      canonicalUrl:
        document.querySelector('link[rel="canonical"]')?.getAttribute("href") ||
        "",
    };
    return meta;
  });

  // TODO: Maybe take fullscreen screenshots here, and then break them up into manageable chunks usable by the LLM.
  // Take screenshot for context
  const cdpSession = await page.context().newCDPSession(page);
  const screenshot = await cdpSession.send("Page.captureScreenshot");
  cdpSession.detach();

  // TODO: Maybe use js-tiktoken here ?
  // Trim markdown to stay within token limit
  const avgTokensPerChar = 0.75;
  const maxChars = Math.floor(tokenLimit / avgTokensPerChar);
  const trimmedMarkdown =
    markdown.length > maxChars
      ? markdown.slice(0, maxChars) + "\n[Content truncated due to length]"
      : markdown;

  // Create messages
  const messages = [
    new SystemMessage(
      `You are an expert at extracting structured information from web pages. Your task is to:
1. Analyze the provided markdown content, metadata, and screenshot of a webpage
2. Extract relevant information based on the provided task and schema (if any)
3. Pay attention to both the text content and visual layout
4. Handle cases where information might be split across different sections
5. Ensure the response is complete and accurate
6. Format the response appropriately based on the schema (if provided)

Remember to:
- Look for information in both the main content and page metadata (title, description, etc.)
- Consider the visual hierarchy and layout of the page
- Handle cases where information might be ambiguous or incomplete
- Ensure the response is complete and accurate`
    ),
    new HumanMessage({
      content: [
        {
          type: "text",
          text: `Extract information from the page${task ? ` according to this task: ${task}` : ""}${schema ? " and format according to the schema" : ""}`,
        },
        { type: "text", text: "Here is the page metadata:" },
        { type: "text", text: JSON.stringify(metadata, null, 2) },
        { type: "text", text: "Here is the page content:" },
        { type: "text", text: trimmedMarkdown },
        { type: "text", text: "Here is a screenshot of the page:" },
        {
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${screenshot.data}`,
          },
        },
      ],
    }),
  ];

  if (schema) {
    // Create structured output chain
    const chain = llm.withStructuredOutput(schema);
    const result = await chain.invoke(messages);
    return result as T extends z.AnyZodObject ? z.infer<T> : string;
  } else {
    // For task-based extraction, get raw response
    const response = await llm.invoke(messages);
    return response.content as T extends z.AnyZodObject ? z.infer<T> : string;
  }
}
