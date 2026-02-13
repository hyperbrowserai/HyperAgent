import type { ActionContext } from "@/types";
import { formatUnknownError } from "@/utils";

const MAX_ACTION_TEXT_CHARS = 400;
const MAX_ACTION_ERROR_CHARS = 600;

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}…`;
}

export function normalizeActionText(
  value: unknown,
  fallback: string,
  maxChars: number = MAX_ACTION_TEXT_CHARS
): string {
  const source =
    typeof value === "string"
      ? value
      : value == null
        ? fallback
        : formatUnknownError(value);
  const normalized = source.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return fallback;
  }
  return truncateText(normalized, maxChars);
}

export function buildActionFailureMessage(
  actionLabel: string,
  error: unknown
): string {
  const normalizedLabel = normalizeActionText(actionLabel, "action");
  const diagnostic = truncateText(
    normalizeActionText(error, "unknown error", MAX_ACTION_ERROR_CHARS),
    MAX_ACTION_ERROR_CHARS
  );
  return `Failed to ${normalizedLabel}: ${diagnostic}`;
}

export function safeReadContextField(
  ctx: ActionContext,
  key: string
): unknown {
  try {
    return (ctx as unknown as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

export function getPageMethod(
  ctx: ActionContext,
  methodName: string
): ((...args: unknown[]) => unknown | Promise<unknown>) | null {
  const page = safeReadContextField(ctx, "page");
  if (!page || (typeof page !== "object" && typeof page !== "function")) {
    return null;
  }
  let value: unknown;
  try {
    value = (page as Record<string, unknown>)[methodName];
  } catch {
    return null;
  }
  if (typeof value !== "function") {
    return null;
  }
  return value.bind(page) as (...args: unknown[]) => unknown | Promise<unknown>;
}

export function invalidateDomCacheSafely(ctx: ActionContext): void {
  const invalidateDomCache = safeReadContextField(ctx, "invalidateDomCache");
  if (typeof invalidateDomCache !== "function") {
    return;
  }
  try {
    invalidateDomCache();
  } catch {
    // best effort only
  }
}
