import TurndownService from "turndown";
import { formatUnknownError } from "./format-unknown-error";
// TODO: Add gfm plugin
// import { gfm } from "joplin-turndown-plugin-gfm";

export const turndownService = new TurndownService();

turndownService.addRule("removeUnwantedTags", {
  filter: ["head", "script", "style"],
  replacement: function () {
    return "";
  },
});

turndownService.addRule("inlineLink", {
  filter: function (
    node: { nodeName: string; getAttribute: (name: string) => string | null },
    options: { linkStyle?: string }
  ) {
    return (
      options.linkStyle === "inlined" &&
      node.nodeName === "A" &&
      Boolean(node.getAttribute("href"))
    );
  },
  replacement: function (
    content: string,
    node: { getAttribute: (name: string) => string | null; title?: string }
  ) {
    const href = (node.getAttribute("href") ?? "").trim();
    const title = node.title ? ` "${node.title}"` : "";
    return "[" + content.trim() + "](" + href + title + ")\n";
  },
});
// turndownService.use(gfm);

const MAX_HTML_TO_MARKDOWN_DIAGNOSTIC_CHARS = 400;

function formatHtmlToMarkdownDiagnostic(value: unknown): string {
  const normalized = Array.from(formatUnknownError(value), (char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code < 32) || code === 127 ? " " : char;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = normalized.length > 0 ? normalized : "unknown error";
  if (fallback.length <= MAX_HTML_TO_MARKDOWN_DIAGNOSTIC_CHARS) {
    return fallback;
  }
  const omittedChars = fallback.length - MAX_HTML_TO_MARKDOWN_DIAGNOSTIC_CHARS;
  return `${fallback.slice(
    0,
    MAX_HTML_TO_MARKDOWN_DIAGNOSTIC_CHARS
  )}... [truncated ${omittedChars} chars]`;
}

const processMultiLineLinks = (markdownContent: string): string => {
  let insideLinkContent = false;
  let newMarkdownContent = "";
  let linkOpenCount = 0;
  for (let i = 0; i < markdownContent.length; i++) {
    const char = markdownContent[i];

    if (char == "[") {
      linkOpenCount++;
    } else if (char == "]") {
      linkOpenCount = Math.max(0, linkOpenCount - 1);
    }
    insideLinkContent = linkOpenCount > 0;

    if (insideLinkContent && char == "\n") {
      newMarkdownContent += "\\" + "\n";
    } else {
      newMarkdownContent += char;
    }
  }
  return newMarkdownContent;
};

const removeSkipToContentLinks = (markdownContent: string): string => {
  // Remove [Skip to Content](#page) and [Skip to content](#skip)
  const newMarkdownContent = markdownContent.replace(
    /\[Skip to Content\]\(#[^)]*\)/gi,
    ""
  );
  return newMarkdownContent;
};

export async function parseMarkdown(
  html: string | null | undefined
): Promise<string> {
  if (!html) {
    return "";
  }
  try {
    let markdownContent = turndownService.turndown(html);
    markdownContent = processMultiLineLinks(markdownContent);
    markdownContent = removeSkipToContentLinks(markdownContent);
    return markdownContent;
  } catch (error) {
    console.error(
      `Error converting HTML to Markdown: ${formatHtmlToMarkdownDiagnostic(
        error
      )}`
    );
    return ""; // Optionally return an empty string or handle the error as needed
  }
}
