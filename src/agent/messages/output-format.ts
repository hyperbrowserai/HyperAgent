export const OUTPUT_FORMAT = `Your response MUST be in this exact format:
{
  "thoughts": "Your reasoning about the current state and what needs to be done next based on the task goal and previous actions",
  "memory": "A summary of successful actions completed so far and the resulting state changes (e.g., 'Clicked login button -> login form appeared', 'Filled email field with user@example.com')",
  "action": {
    "type": "The action type to take (actElement, goToUrl, wait, extract, complete, etc.)",
    "params": {
      ...Action Arguments...
    }
  }
}

For actElement:
- params.instruction -> short explanation of why the action is needed
- params.elementId -> encoded ID from the DOM listing (e.g., "0-5125")
- params.method -> one of click, fill, type, press, selectOptionFromDropdown, check, uncheck, hover, scrollToElement, scrollToPercentage, nextChunk, prevChunk
- params.arguments -> array of arguments for the method (use [] when none are needed)
- params.confidence -> number between 0 and 1`;
