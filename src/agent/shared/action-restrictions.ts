/**
 * Action restrictions for element interactions
 * Defines which Playwright methods are allowed for different contexts
 */

/**
 * Actions allowed for aiAction (executeSingleAction)
 * These are all the Playwright methods that can be executed via natural language
 *
 * aiAction uses a high retry count (10) and is designed for one-off commands
 * where the user directly specifies what they want to do.
 */
export const AIACTION_ALLOWED_ACTIONS = [
  // Click actions
  "click",

  // Input actions
  "fill", // Clear and fill input
  "type", // Type character by character
  "press", // Press keyboard key

  // Selection actions
  "selectOptionFromDropdown", // For <select> elements

  // Checkbox actions
  "check",
  "uncheck",

  // Hover action
  "hover",

  // Scroll actions
  "scrollTo", // Scroll to position (%, 'top', 'bottom')
  "nextChunk", // Scroll down one viewport
  "prevChunk", // Scroll up one viewport
] as const;

export type AiActionAllowedAction = (typeof AIACTION_ALLOWED_ACTIONS)[number];

/**
 * Actions allowed for agent-driven element interactions (actElement)
 * These are the Playwright methods that the executeTask agent can use
 *
 * Agent actions use fewer retries (3) because the agent loop itself
 * provides higher-level retry and error recovery logic.
 *
 * Currently uses the same action set as aiAction.
 */
export const AGENT_ELEMENT_ACTIONS = [
  // Click actions
  "click",

  // Input actions
  "fill", // Clear and fill input
  "type", // Type character by character
  "press", // Press keyboard key

  // Selection actions
  "selectOptionFromDropdown", // For <select> elements

  // Checkbox actions
  "check",
  "uncheck",

  // Hover action
  "hover",

  // Scroll actions
  "scrollTo", // Scroll to position (%, 'top', 'bottom')
  "nextChunk", // Scroll down one viewport
  "prevChunk", // Scroll up one viewport
] as const;

export type AgentElementAction = (typeof AGENT_ELEMENT_ACTIONS)[number];

/**
 * Action descriptions for documentation and prompts
 * Maps each action to its description and example usage
 */
export const ACTION_DESCRIPTIONS = {
  click: {
    arguments: "none",
    description: "Click on an element",
    example: 'click the Login button',
  },
  fill: {
    arguments: "text: string",
    description: "Fill input (clears first)",
    example: "fill 'john@example.com' into email field",
  },
  type: {
    arguments: "text: string",
    description: "Type character by character",
    example: "type 'search query' into search box",
  },
  press: {
    arguments: "key: string",
    description: "Press keyboard key",
    example: "press Enter",
  },
  selectOptionFromDropdown: {
    arguments: "option: string",
    description: "Select from <select>",
    example: "select 'California' from state dropdown",
  },
  check: {
    arguments: "none",
    description: "Check a checkbox",
    example: "check the terms checkbox",
  },
  uncheck: {
    arguments: "none",
    description: "Uncheck a checkbox",
    example: "uncheck the newsletter checkbox",
  },
  hover: {
    arguments: "none",
    description: "Hover over element",
    example: "hover over profile menu",
  },
  scrollTo: {
    arguments: "position: string",
    description: "Scroll to position",
    example: "scroll to 50%",
  },
  nextChunk: {
    arguments: "none",
    description: "Scroll down one viewport",
    example: "scroll down one page",
  },
  prevChunk: {
    arguments: "none",
    description: "Scroll up one viewport",
    example: "scroll up one page",
  },
} as const;
