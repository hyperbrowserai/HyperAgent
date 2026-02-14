const DEFAULT_PAGE_URL_FALLBACK = "about:blank";

function sanitizePageUrlText(value: string): string {
  if (value.length === 0) {
    return value;
  }
  return Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code < 32) || code === 127 ? " " : char;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function truncatePageUrl(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}... [truncated ${omitted} chars]`;
}

export function normalizePageUrl(
  value: unknown,
  options?: {
    fallback?: string;
    maxChars?: number;
  }
): string {
  const fallbackCandidate =
    typeof options?.fallback === "string"
      ? sanitizePageUrlText(options.fallback)
      : DEFAULT_PAGE_URL_FALLBACK;
  const fallback =
    fallbackCandidate.length > 0 ? fallbackCandidate : DEFAULT_PAGE_URL_FALLBACK;
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = sanitizePageUrlText(value);
  if (normalized.length === 0) {
    return fallback;
  }
  const maxChars = options?.maxChars;
  if (
    typeof maxChars !== "number" ||
    !Number.isFinite(maxChars) ||
    maxChars <= 0
  ) {
    return normalized;
  }
  return truncatePageUrl(normalized, Math.floor(maxChars));
}
