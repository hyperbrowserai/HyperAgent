/**
 * Instruction similarity and normalization for semantic cache matching
 *
 * Normalizes instructions to increase cache hit rate for semantically
 * equivalent queries like "Get product prices" vs "Get the prices of products"
 */

import { sha256 } from "./hash";

/**
 * Common English stop words to remove during normalization
 */
const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "shall",
  "can",
  "of",
  "in",
  "to",
  "for",
  "with",
  "on",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "and",
  "but",
  "if",
  "or",
  "because",
  "until",
  "while",
  "this",
  "that",
  "these",
  "those",
  "am",
  "it",
  "its",
  "me",
  "my",
  "myself",
  "we",
  "our",
  "ours",
  "ourselves",
  "you",
  "your",
  "yours",
  "yourself",
  "yourselves",
  "he",
  "him",
  "his",
  "himself",
  "she",
  "her",
  "hers",
  "herself",
  "they",
  "them",
  "their",
  "theirs",
  "themselves",
  "what",
  "which",
  "who",
  "whom",
  "i",
  "please",
  "get",
  "find",
  "show",
  "give",
  "tell",
  "let",
  "make",
]);

/**
 * Simple suffix-stripping stemmer
 * Handles common English suffixes for word normalization
 * Conservative approach - only handles clear cases to avoid over-stemming
 */
function simpleStem(word: string): string {
  // Handle common plural and verb forms
  if (word.endsWith("ies") && word.length > 4) {
    return word.slice(0, -3) + "y";
  }
  // "boxes" -> "box", "classes" -> "class"
  if (word.endsWith("xes") || word.endsWith("sses") || word.endsWith("ches") || word.endsWith("shes")) {
    return word.slice(0, -2);
  }
  // "prices" -> "price" (words ending in consonant + es where e is part of the word)
  if (word.endsWith("ces") || word.endsWith("ges") || word.endsWith("ses") || word.endsWith("zes")) {
    return word.slice(0, -1); // Just remove the 's'
  }
  // Simple plural: "products" -> "product"
  if (word.endsWith("s") && word.length > 3 && !word.endsWith("ss") && !word.endsWith("us") && !word.endsWith("is")) {
    return word.slice(0, -1);
  }
  // "clicking" -> "click", but keep final consonant for words like "running" -> "run"
  if (word.endsWith("ing") && word.length > 5) {
    const base = word.slice(0, -3);
    // Check for doubled consonant pattern: running -> run, clicking -> click
    if (base.length > 2 && base[base.length - 1] === base[base.length - 2]) {
      return base.slice(0, -1);
    }
    return base;
  }
  // "clicked" -> "click"
  if (word.endsWith("ed") && word.length > 4) {
    const base = word.slice(0, -2);
    // Check for doubled consonant
    if (base.length > 2 && base[base.length - 1] === base[base.length - 2]) {
      return base.slice(0, -1);
    }
    return base;
  }
  if (word.endsWith("ly") && word.length > 4) {
    return word.slice(0, -2);
  }
  return word;
}

/**
 * Normalize an instruction for semantic matching
 *
 * Process:
 * 1. Lowercase
 * 2. Remove punctuation
 * 3. Split into words
 * 4. Remove stop words
 * 5. Stem remaining words
 * 6. Sort alphabetically
 * 7. Join with space
 *
 * Examples:
 * - "Get product prices" -> "price product"
 * - "Get the prices of products" -> "price product"
 * - "Click the submit button" -> "button click submit"
 */
export function normalizeInstruction(instruction: string): string {
  // Lowercase and remove punctuation
  const cleaned = instruction
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Split, filter stop words, stem, sort
  const words = cleaned
    .split(" ")
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .map(simpleStem)
    .filter((word) => word.length > 1);

  // Remove duplicates and sort
  const uniqueWords = [...new Set(words)].sort();

  return uniqueWords.join(" ");
}

/**
 * Compute a hash of the normalized instruction
 * Use this in cache keys for semantic matching
 */
export function computeInstructionHash(instruction: string): string {
  const normalized = normalizeInstruction(instruction);
  return sha256(normalized);
}

/**
 * Check if two instructions are semantically similar
 * Returns true if they normalize to the same form
 */
export function areInstructionsSimilar(
  instruction1: string,
  instruction2: string
): boolean {
  return (
    normalizeInstruction(instruction1) === normalizeInstruction(instruction2)
  );
}
