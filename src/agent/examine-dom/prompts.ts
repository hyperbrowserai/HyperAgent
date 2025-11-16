/**
 * Prompts for examineDom function
 * Optimized for element finding in accessibility trees
 */

/**
 * System prompt for element finding
 */
export function buildExamineDomSystemPrompt(): string {
  return `You are helping the user automate the browser by finding elements based on what the user wants to observe in the page.

You will be given:
1. an instruction of elements to observe
2. a hierarchical accessibility tree showing the semantic structure of the page. The tree is a hybrid of the DOM and the accessibility tree.

Return an array of elements that match the instruction if they exist, otherwise return an empty array.`;
}

/**
 * Build detailed instruction for action-based element finding
 * Provides specific guidance for different action types
 */
export function buildActionInstruction(action: string): string {
  const supportedActions = [
    "click",
    "fill",
    "type",
    "press",
    "scrollToElement",
    "scrollToPercentage",
    "nextChunk",
    "prevChunk",
    "selectOptionFromDropdown",
    "hover",
    "check",
    "uncheck",
  ];

  const instruction = `Find the most relevant element to perform an action on given the following action: ${action}.
Provide an action for this element such as ${supportedActions.join(", ")}, or any other playwright locator method. Remember that to users, buttons and links look the same in most cases.
If the action is completely unrelated to a potential action to be taken on the page, return an empty array.
ONLY return one action. If multiple actions are relevant, return the most relevant one.
For scroll actions (scrollToElement, scrollToPercentage, nextChunk, prevChunk), prefer elements marked as "scrollable" in their role. These have been automatically detected as scrollable containers. If no scrollable elements are available, choose the html element as a fallback.
Use scrollToElement (no arguments) when the request is to reveal a specific section or component. Use scrollToPercentage (with a percentage argument like "50%" or "75%") only when the user explicitly mentions a relative position on the page.
If the user is asking to scroll to the next chunk/previous chunk, choose the nextChunk/prevChunk method. No arguments are required here.
If the action implies a key press, e.g., 'press enter', 'press a', 'press space', etc., always choose the press method with the appropriate key as argument — e.g. 'a', 'Enter', 'Space'. Do not choose a click action on an on-screen keyboard. Capitalize the first character like 'Enter', 'Tab', 'Escape' only for special keys.
If the action implies choosing an option from a dropdown, AND the corresponding element is a 'select' element, choose the selectOptionFromDropdown method. The argument should be the text of the option to select.
If the action implies choosing an option from a dropdown, and the corresponding element is NOT a 'select' element, choose the click method.`;

  return instruction;
}

/**
 * User prompt for element finding
 * Provides instruction and accessibility tree
 */
export function buildExamineDomUserPrompt(
  instruction: string,
  tree: string
): string {
  // Build detailed instruction for actions
  const detailedInstruction = buildActionInstruction(instruction);

  return `instruction: ${detailedInstruction}

Accessibility Tree:
${tree}`;
}
