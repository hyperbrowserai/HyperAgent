import { getEncoding } from "js-tiktoken";

// Use cl100k_base as it is the standard for modern OpenAI models (GPT-3.5/4)
// and serves as a good approximation for other models.
const enc = getEncoding("cl100k_base");

/**
 * Counts the number of tokens in a text string.
 */
export function countTokens(text: string): number {
  return enc.encode(text).length;
}

/**
 * Truncates text to a maximum number of tokens.
 * Appends a truncation message if truncated.
 */
export function truncateToTokenLimit(
  text: string,
  tokenLimit: number,
  truncationMessage = "\n[Content truncated due to length]"
): string {
  const tokens = enc.encode(text);

  if (tokens.length <= tokenLimit) {
    return text;
  }

  // Reserve tokens for the truncation message
  const messageTokens = enc.encode(truncationMessage).length;
  // If the limit is so small it can't even fit the message, just return as much message as possible or empty string?
  // Let's assume limit is reasonable. If not, we prioritize the text? No, message is important to know it was truncated.
  // But if limit < messageTokens, we can't do much.

  const availableTokens = Math.max(0, tokenLimit - messageTokens);

  const truncatedTokens = tokens.slice(0, availableTokens);
  return enc.decode(truncatedTokens) + truncationMessage;
}
