import type TurndownService from "turndown";

declare module "joplin-turndown-plugin-gfm" {
  function gfm(service: TurndownService): void;
  function highlightedCodeBlock(service: TurndownService): void;
  function strikethrough(service: TurndownService): void;
  function tables(service: TurndownService): void;
  function taskListItems(service: TurndownService): void;

  export { gfm, highlightedCodeBlock, strikethrough, tables, taskListItems };
}
