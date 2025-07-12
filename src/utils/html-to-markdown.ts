import TurndownService from "turndown";
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
  filter: function (node: any, options: any) {
    return (
      options.linkStyle === "inlined" &&
      node.nodeName === "A" &&
      node.getAttribute("href")
    );
  },
  replacement: function (content: string, node: any) {
    var href = node.getAttribute("href").trim();
    var title = node.title ? ' "' + node.title + '"' : "";
    return "[" + content.trim() + "](" + href + title + ")\n";
  },
});
// turndownService.use(gfm);

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
    /\[Skip to Content\]\(#[^\)]*\)/gi,
    "",
  );
  return newMarkdownContent;
};

export async function parseMarkdown(
  html: string | null | undefined,
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
    console.error("Error converting HTML to Markdown", { error });
    return ""; // Optionally return an empty string or handle the error as needed
  }
}
