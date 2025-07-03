export const OUTPUT_FORMAT_FIND_ELEMENT = `
Your response MUST be in this exact format:
{
  "index": "The index number of the element you found"
}
  `;

export const OUTPUT_FORMAT = `Your response MUST be in this exact format:
{
  "thoughts": "Your thoughts on the task at hand, was the previous goal successful?",
  "memory": "Information that you need to remember to accomplish subsequent goals",
  "nextGoal": "The next goal you are trying to accomplish with the actions you have chosen",
  "actions": [
    {
      "action": "The action you will take",
      "params": {
        ...Action Arguments...
      }
    }
  ]
}`;