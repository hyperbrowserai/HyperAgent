import { GoToURLActionDefinition } from "./go-to-url";
import { CompleteActionDefinition } from "./complete";
import { generateCompleteActionWithOutputDefinition } from "./complete-with-output-schema";
import { ExtractActionDefinition } from "./extract";
import { PageBackActionDefinition } from "./page-back";
import { PageForwardActionDefinition } from "./page-forward";
import { ThinkingActionDefinition } from "./thinking";
import { RefreshPageActionDefinition } from "./refresh-page";
import { PDFActionDefinition } from "./pdf";
import { ActElementActionDefinition } from "./act-element";
import { WaitActionDefinition } from "./wait";

/**
 * Custom error class for when an action is not found in the registry
 * This helps distinguish between general errors and specifically when an action type doesn't exist
 */
export class ActionNotFoundError extends Error {
  constructor(actionType: string) {
    super(`Action type "${actionType}" not found in the action registry`);
    this.name = "ActionNotFoundError";

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ActionNotFoundError);
    }
  }
}

const DEFAULT_ACTIONS = [
  // Navigation actions
  GoToURLActionDefinition,
  // PageBackActionDefinition,
  // PageForwardActionDefinition,
  RefreshPageActionDefinition,

  // Element interaction (natural language)
  ActElementActionDefinition,

  // Other actions
  ExtractActionDefinition,
  // ThinkingActionDefinition, // Disabled: agents waste steps thinking instead of acting; thoughts field already provides reasoning
  WaitActionDefinition,
];

if (process.env.GEMINI_API_KEY) {
  DEFAULT_ACTIONS.push(PDFActionDefinition);
}

export {
  DEFAULT_ACTIONS,
  CompleteActionDefinition,
  generateCompleteActionWithOutputDefinition,
};
