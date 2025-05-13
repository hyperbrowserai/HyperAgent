import { parseMarkdown } from "@/utils/html-to-markdown";
import { Page } from "playwright";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { AgentActionDefinition } from "@/types/agent/actions/types";
import { z } from "zod";
import sharp from "sharp";
import fs from "fs/promises";
import path from "path";
import { getStructuredOutputMethod } from "@/agent/llms/structured-output";

// Function to build the extraction schema with action as enum
function ScanExtractionSchema(actionTypes: string[]) {
  if (actionTypes.length === 0) {
    throw new Error("actionTypes must be a non-empty array");
  }
  // TypeScript workaround: cast to [string, ...string[]] for z.enum
  return z.object({
    pageDescription: z
      .string()
      .describe(
        "A detailed description of the overall structure, layout, and user-facing features of the page."
      ),
    elementGroups: z
      .array(
        z.object({
          name: z
            .string()
            .describe(
              "The name or phrase for the element group or category (e.g., 'Navigation Bar', 'Search Filters', 'Product Listing')."
            ),
          description: z
            .string()
            .describe("A suitable description of things in the given group"),
          actions: z
            .array(
              z.object({
                action: z.enum([...actionTypes] as unknown as [
                  string,
                  ...string[],
                ]),
                target: z
                  .string()
                  .describe(
                    "A human-readable description of what the action wants to interact with (e.g., 'the search input box', 'the filter dropdown for price', 'the add to cart button on a product card')."
                  ),
                intent: z
                  .string()
                  .describe(
                    "The intent or purpose behind performing this action on this group, and what is expected as an outcome or result of performing it (e.g., 'to update the search results with the new query', 'to display more filter options', 'to add the selected product to the shopping cart')."
                  ),
              })
            )
            .describe(
              "List of possible actions for this group, with target and intent."
            ),
        })
      )
      .describe(
        "List of element groups or categories of elements on the page, each with possible actions, their targets, and their intent."
      ),
  });
}

export interface ExtractOptions {
  page: Page;
  llm: BaseChatModel;
  tokenLimit: number;
  actions: Array<AgentActionDefinition>;
}

async function chunkScreenshot(
  screenshotBuffer: Buffer,
  maxWidth: number,
  maxHeight: number
): Promise<Buffer[]> {
  // Always resize to maxWidth for consistency
  const resizedBuffer = await sharp(screenshotBuffer)
    .resize({ width: maxWidth })
    .png()
    .toBuffer();
  const resizedImage = sharp(resizedBuffer);
  const resizedMeta = await resizedImage.metadata();
  const totalHeight = resizedMeta.height || 0;
  const totalWidth = resizedMeta.width || maxWidth;
  console.log(
    `[chunkScreenshot] Full image height: ${totalHeight}, width: ${totalWidth}`
  );
  const chunks: Buffer[] = [];
  for (let y = 0; y < totalHeight; y += maxHeight) {
    const chunkHeight = Math.min(maxHeight, totalHeight - y);
    if (chunkHeight <= 0) continue;
    console.log(
      `[chunkScreenshot] Extracting area: left=0, top=${y}, width=${totalWidth}, height=${chunkHeight}`
    );
    const chunk = await resizedImage
      .clone()
      .extract({
        left: 0,
        top: y,
        width: totalWidth,
        height: chunkHeight,
      })
      .png()
      .toBuffer();
    chunks.push(chunk);
  }
  return chunks;
}

function getLLMMaxImageSize(llm: BaseChatModel): {
  width: number;
  height: number;
} {
  const name = llm.getName?.() || "";
  if (name.toLowerCase().includes("anthropic"))
    return { width: 1568, height: 1568 };
  if (name.toLowerCase().includes("openai"))
    return { width: 1024, height: 1024 };
  if (name.toLowerCase().includes("gemini"))
    return { width: 1024, height: 1024 };
  // Add more as needed
  return { width: 512, height: 512 }; // Safe default
}

export async function PageScanFn({
  page,
  llm,
  tokenLimit,
  actions,
}: ExtractOptions) {
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

  // Take full-page screenshot using CDP
  const cdpSession = await page.context().newCDPSession(page);
  await cdpSession.send("Page.enable");
  const screenshotResult = await cdpSession.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    fromSurface: true,
  });
  await cdpSession.detach();
  const screenshotBuffer = Buffer.from(screenshotResult.data, "base64");
  const { width: MAX_WIDTH, height: MAX_HEIGHT } = getLLMMaxImageSize(llm);

  // Optionally save the original image to debug directory before chunking
  let debugDir: string | undefined = undefined;
  if (process.env.DEBUG_SCREENSHOTS) {
    debugDir = path.resolve(
      process.env.DEBUG_SCREENSHOTS,
      `scan-${Date.now()}`
    );
    await fs.mkdir(debugDir, { recursive: true });
    await fs.writeFile(path.join(debugDir, "original.png"), screenshotBuffer);
  }

  // Chunk the screenshot
  const imageChunks = await chunkScreenshot(
    screenshotBuffer,
    MAX_WIDTH,
    MAX_HEIGHT
  );

  // Optionally save image chunks to debug directory
  if (debugDir) {
    await Promise.all(
      imageChunks.map((chunk, idx) =>
        fs.writeFile(path.join(debugDir!, `chunk-${idx + 1}.png`), chunk)
      )
    );
  }

  const imageContents = imageChunks.map((chunk, idx) => ({
    type: "image_url",
    image_url: {
      url: `data:image/png;base64,${chunk.toString("base64")}`,
      detail: idx === 0 ? "high" : undefined,
    },
  }));

  // TODO: Maybe use js-tiktoken here ?
  // Trim markdown to stay within token limit
  const avgTokensPerChar = 0.75;
  const maxChars = Math.floor(tokenLimit / avgTokensPerChar);
  const trimmedMarkdown =
    markdown.length > maxChars
      ? markdown.slice(0, maxChars) + "\n[Content truncated due to length]"
      : markdown;

  const filteredActions = actions.filter(
    (action) => !action.shouldIgnoreActionForScan
  );

  // Prepare actions summary for the LLM
  const actionsSummary = filteredActions
    .map((a) => `- ${a.type}: ${a.actionParams.description ?? ""}`)
    .join("\n");

  // Create messages
  const messages = [
    new SystemMessage(
      `You are an expert at analyzing and describing the structure and general layout of web pages. Your task is to:

1. Carefully examine the provided page content, metadata, screenshot, and the list of possible actions that can be performed on this page.
2. Identify and describe the main sections and interactive elements of the page.
3. Summarize the general purpose and functionality of the page.
4. List the types of information and controls available to the user (e.g., navigation links, search bars, filters, listings, forms).
5. For each major section, provide a rich, specific, and comprehensive description of what it contains, how it is visually structured, and how it contributes to the user experience. Be as detailed as possible, including layout, repeated elements, and any visual cues.
6. Note any repeated patterns (such as listings, cards, or tables) and what information they display.
7. Mention any prominent calls to action or interactive features (e.g., buttons, dropdowns, maps).
8. For each element group or category you identify, return the list of all possible actions (from the provided list) that can be performed on that group. For each action, also explain the intent or purpose behind performing that action. Only include actions that are relevant to that group.

Be thorough and clear, focusing on the overall structure and user-facing features, not just the raw text. Your description should help someone unfamiliar with the page quickly understand its layout, main features, and how a user might interact with it. Try to be exhaustive with your action listings. So if there are multiple distinct input boxes in a selection, then list out each distinct selection. If the input boxes start feeling more generic and similar, then you can group them into one general action.

Make sure that your final response covers to a reasonable extent the element groups or categories of elements available on the page, and that each group has a detailed, illustrative description.
---

Example Output for a Real Estate Listings Page (Structured):

pageDescription: This real estate listings page is designed to help users search for, filter, and compare properties for sale or rent. The layout includes a header with navigation, a search bar, filter controls, an interactive map, and a list of property cards. The page supports property discovery, comparison, and contacting agents, with intuitive controls and clear calls to action.

elementGroups:
- name: Header
  description: The top navigation bar spans the full width of the page and contains clearly labeled links for "Buy", "Rent", "Sell", "Get a mortgage", and "Find an Agent". These links are visually separated and often highlighted with icons or color cues. The header may also include user account access, notifications, and saved searches, providing quick access to essential site features from any page.
  actions:
    - action: clickElement
      target: 'the navigation links for Buy, Rent, Sell, Get a mortgage, and Find an Agent'
      intent: Navigate to different real estate services (buy, rent, sell, etc.) to display the relevant listings or service page for the user.
    - action: clickElement
      target: 'the user account icon, saved searches button, or agent contact link in the header'
      intent: Access user account, saved searches, or agent contact options so the user can manage their account, view saved searches, or contact an agent directly.

- name: Search Bar
  description: A prominent, centrally located input box allows users to enter a zip code, city, or address. The search bar is often accompanied by a magnifying glass icon and a large, visually distinct search button. It may include autocomplete suggestions and recent searches, making it easy for users to quickly specify their area of interest.
  actions:
    - action: inputText
      target: 'the main search input box for location or address'
      intent: Enter a location or address to search for properties in a specific area, so the results update to match the user's query.
    - action: clickElement
      target: 'the search button next to the search bar'
      intent: Submit the search query to update property results, causing the listings and map to refresh with new data.

- name: Filter Controls
  description: Directly below the search bar, a horizontal row of dropdowns and buttons allows users to filter properties by sale type (for sale, for rent), price range (with sliders or preset buttons), number of bedrooms and bathrooms, home type (house, condo, etc.), and additional features like square footage, year built, or amenities. Each filter is clearly labeled, and selected filters are visually highlighted. Filters update results in real time and may include "clear all" or "more filters" options.
  actions:
    - action: selectOption
      target: 'the dropdowns and sliders for price, beds, baths, home type, and more'
      intent: Refine property results by selecting specific criteria (price, beds, baths, etc.), so the listings shown match the user's preferences.
    - action: clickElement
      target: 'the filter dropdown toggles or clear filters button'
      intent: Open or close filter dropdowns, apply or clear filters, so the user can adjust or reset their search criteria and see updated results.

- name: Map
  description: An interactive map occupies a significant portion of the page, typically on the left or top. It displays property locations as pins or price markers, with clustering for dense areas. The map supports zooming, panning, and clicking on markers to highlight or preview property details. Visual cues such as color-coded markers or tooltips help users quickly assess property distribution and pricing trends in the area.
  actions:
    - action: clickElement
      target: 'a property marker or pin on the map'
      intent: Select a property marker to view details or highlight the corresponding listing, so the user can quickly see more information about a specific property.
    - action: scroll
      target: 'the map area to pan or zoom'
      intent: Pan or zoom the map to explore different areas, allowing the user to navigate to neighborhoods of interest.
    - action: extract
      target: 'the map and its markers to gather geographic data'
      intent: Gather geographic data or property distribution for analysis, so the user or system can understand trends or generate reports.

- name: Property Listings
  description: A vertical list of property cards appears beside or below the map. Each card features a high-resolution image, bold price, number of bedrooms and bathrooms, square footage, full address, and the listing agent or company. Cards may include badges like "New", "Open House", or "Price Reduced". Hovering over a card highlights the corresponding map marker. Cards are spaced for easy scanning and may include quick action buttons for saving or sharing.
  actions:
    - action: extract
      target: 'the property cards in the listings area'
      intent: Gather property details (price, size, features) for comparison or analysis, so the user can make informed decisions.
    - action: clickElement
      target: 'a property card or its details link'
      intent: Select a property card to view more details or contact the agent, enabling the user to proceed with inquiries or a purchase.
    - action: clickElement
      target: 'the favorite or save button on a property card'
      intent: Click on the save button to save a property for later review or comparison, so the user can easily revisit interesting listings.

- name: Pagination and Sorting
  description: At the bottom or top of the listings, pagination controls allow users to move between pages of results. Sorting dropdowns let users reorder listings by price, newest, or other criteria. Controls are clearly labeled and provide feedback on the current page or sort order.
  actions:
    - action: clickElement
      target: 'the previous page button in the pagination controls'
      intent: Go to the previous page of property listings, so the user can browse earlier results.
    - action: clickElement
      target: 'the next page button in the pagination controls'
      intent: Go to the next page of property listings, so the user can see more properties.
    - action: selectOption
      target: 'the sorting dropdown for listings order'
      intent: Change the sorting order of the listings, so the user can view properties by their preferred criteria.

---

Example Output for an Amazon.com Search Results Page (Structured):

pageDescription: This Amazon search results page for "Playing Cards" is designed to help users efficiently discover, compare, and purchase products. The layout includes a header with navigation and search, a sidebar for filters, a main content area with product listings, and interactive elements for sorting, filtering, and purchasing. The page supports product discovery, comparison, and purchasing with intuitive controls and clear calls to action.

elementGroups:
- name: Header
  description: The top section of the page features the Amazon logo (linking to the homepage), a delivery location indicator, a large search bar with a category dropdown, language selector, account and order links, and a shopping cart icon. The header is persistent and provides quick access to essential shopping and account features from anywhere on the site.
  actions:
    - action: inputText
      target: 'the main search input box for product keywords'
      intent: Enter search terms or keywords to find specific products, so the search results update to match the user's query.
    - action: selectOption
      target: 'the category dropdown next to the search bar'
      intent: Choose a product category to narrow the search scope, so only relevant products are shown.
    - action: clickElement
      target: 'the account, orders, or cart icons in the header'
      intent: Access account, orders, or cart for account management or checkout, allowing the user to manage their account or proceed to purchase.

- name: Navigation Menu
  description: A horizontal menu below the header provides links to popular Amazon categories and services such as "Amazon Haul", "Best Sellers", "Music", and more. Each link is clearly labeled and may include icons or dropdowns for subcategories, allowing users to quickly jump to different parts of the site.
  actions:
    - action: clickElement
      target: 'the navigation links for Amazon categories and services'
      intent: Navigate to specific categories or services for further browsing, so the user can explore more product types or deals.

- name: Filters Sidebar
  description: The left sidebar contains a comprehensive set of filters, including checkboxes and dropdowns for brands, customer reviews, shipping options, price range, deals, themes, and more. Filters are grouped by type, with expandable sections and clear labels. Selecting a filter instantly updates the product results, and selected filters are visually highlighted for easy reference.
  actions:
    - action: selectOption
      target: 'the filter checkboxes, dropdowns, and sliders in the sidebar'
      intent: Apply filters to narrow down the list of displayed products, so the user only sees items matching their preferences.
    - action: clickElement
      target: 'the filter category toggles in the sidebar'
      intent: Expand or collapse filter categories for easier navigation, making it simpler to find and apply filters.

- name: Main Content Area
  description: The central area of the page displays sponsored banners or carousels at the top, followed by a grid of product cards. Each card includes a product image, title, price (with discounts or Prime badges), average rating, number of reviews, and an "Add to cart" button. Badges like "Best Seller" or "Amazon's Choice" highlight popular products. Hovering over a card may reveal additional options or quick actions.
  actions:
    - action: extract
      target: 'the product cards in the search results area'
      intent: Gather product details (price, ratings, descriptions) for comparison or analysis, so the user can make informed purchasing decisions.
    - action: clickElement
      target: 'a product card or its details link'
      intent: Select a product to view more details or add to cart, enabling the user to proceed to checkout or learn more about the product.
    - action: clickElement
      target: 'the add to cart button on a product card'
      intent: Add a product directly to the shopping cart for purchase, so the item is ready for checkout.
    - action: scroll
      target: 'the main content area with product listings'
      intent: Navigate through the list of products to explore all available options, allowing the user to browse more items.

- name: Pagination
  description: Pagination controls at the bottom of the product listings allow users to move between pages of results. The controls are clearly labeled with page numbers and next/previous buttons, providing feedback on the current page and total results.
  actions:
    - action: clickElement
      target: 'the previous page button in the pagination controls'
      intent: Go to the previous page of search results, so the user can review earlier products.
    - action: clickElement
      target: 'the next page button in the pagination controls'
      intent: Go to the next page of search results, so the user can see more products.

- name: Promotions and Badges
  description: Throughout the product listings, visual indicators such as "Best Seller", "Amazon's Choice", or limited-time deal banners highlight special offers and recommended products. These badges are color-coded and positioned prominently on product cards to catch the user's attention.
  actions:
    - action: extract
      target: 'the badges and banners on product cards'
      intent: Identify and highlight special deals or recommended products for the user, so they can quickly spot popular or discounted items.

---

(Repeat this structure for other types of pages or sections as needed.)`
    ),
    new HumanMessage({
      content: [
        {
          type: "text",
          text: `Analyze the web page and provide a detailed description of its structure, layout, main sections, interactive elements, and user-facing features. Use the provided metadata, page content, and screenshot to inform your analysis. Note: The page content has been converted to a readable format using markdown, which may be lossy. If some information appears to be missing or unclear, make your best guess, but be conservative and cautious about filling in gaps or making assumptions.`,
        },
        { type: "text", text: "Here is the page metadata:" },
        { type: "text", text: JSON.stringify(metadata, null, 2) },
        {
          type: "text",
          text: "Here is the list of possible actions that can be performed on this page (with their descriptions). These are the only action options available to you, make sure to respond only with options from among these.",
        },
        { type: "text", text: actionsSummary },
        { type: "text", text: "Here is the page content:" },
        { type: "text", text: trimmedMarkdown },
        { type: "text", text: "Here are screenshots of the page (chunked):" },
        ...imageContents,
      ],
    }),
  ];

  // Use structured output chain

  const chain = llm.withStructuredOutput(
    ScanExtractionSchema(filteredActions.map((a) => a.type)),
    {
      method: getStructuredOutputMethod(llm),
    }
  );
  const result = await chain.invoke(messages);
  return result;
}
