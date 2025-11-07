export const OUTPUT_FORMAT = `Your response MUST be in this exact format:
{
  "thoughts": "Your reasoning about the current state and what needs to be done next based on the task goal and previous actions",
  "memory": "A summary of successful actions completed so far and the resulting state changes (e.g., 'Clicked login button -> login form appeared', 'Filled email field with user@example.com')",
  "action": {
    "type": "The action type to take (actElement, goToUrl, wait, thinking, extract, complete, etc.)",
    "params": {
      ...Action Arguments...
    }
  }
}`