import { formatUnknownError } from "@/utils";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return false;
  }
  return prototype === Object.prototype || prototype === null;
}

const UNSAFE_OPTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_PROVIDER_OPTIONS_DEPTH = 20;
const MAX_PROVIDER_OPTION_KEY_CHARS = 256;
const MAX_PROVIDER_OPTION_STRING_CHARS = 20_000;
const MAX_PROVIDER_OPTIONS_DIAGNOSTIC_CHARS = 200;

function stripControlChars(value: string): string {
  return Array.from(value)
    .map((char) => {
      const code = char.charCodeAt(0);
      return (code >= 0 && code < 32) || code === 127 ? " " : char;
    })
    .join("");
}

function formatProviderOptionDiagnostic(value: unknown): string {
  const normalized = stripControlChars(
    typeof value === "string" ? value : formatUnknownError(value)
  )
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= MAX_PROVIDER_OPTIONS_DIAGNOSTIC_CHARS) {
    return normalized;
  }
  return `${normalized.slice(
    0,
    MAX_PROVIDER_OPTIONS_DIAGNOSTIC_CHARS
  )}... [truncated ${normalized.length - MAX_PROVIDER_OPTIONS_DIAGNOSTIC_CHARS} chars]`;
}

function truncateProviderOptionString(value: string): string {
  if (value.length <= MAX_PROVIDER_OPTION_STRING_CHARS) {
    return value;
  }
  return `${value.slice(
    0,
    MAX_PROVIDER_OPTION_STRING_CHARS
  )}... [truncated ${value.length - MAX_PROVIDER_OPTION_STRING_CHARS} chars]`;
}

function normalizeOptionKey(key: string): string {
  const normalized = stripControlChars(key).replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_PROVIDER_OPTION_KEY_CHARS) {
    return normalized;
  }
  return normalized.slice(0, MAX_PROVIDER_OPTION_KEY_CHARS);
}

function toComparableOptionKey(key: string): string {
  return normalizeOptionKey(key).toLowerCase();
}

function sanitizeOptionValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number
): unknown {
  if (depth >= MAX_PROVIDER_OPTIONS_DEPTH) {
    return "[MaxDepthExceeded]";
  }

  if (typeof value === "string") {
    return truncateProviderOptionString(value);
  }

  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
  }

  if (Array.isArray(value)) {
    try {
      return value.map((entry) => sanitizeOptionValue(entry, seen, depth + 1));
    } catch (error) {
      return `[UnserializableArray: ${formatProviderOptionDiagnostic(error)}]`;
    } finally {
      seen.delete(value);
    }
  }

  if (isPlainRecord(value)) {
    try {
      const sanitizedEntries = new Map<string, unknown>();
      for (const [rawKey, entry] of Object.entries(value)) {
        const normalizedKey = normalizeOptionKey(rawKey);
        const comparableKey = normalizedKey.toLowerCase();
        if (normalizedKey.length === 0) {
          continue;
        }
        if (UNSAFE_OPTION_KEYS.has(comparableKey)) {
          continue;
        }
        sanitizedEntries.set(
          normalizedKey,
          sanitizeOptionValue(entry, seen, depth + 1)
        );
      }
      return Object.fromEntries(sanitizedEntries);
    } catch (error) {
      return `[UnserializableObject: ${formatProviderOptionDiagnostic(error)}]`;
    } finally {
      seen.delete(value);
    }
  }

  if (typeof value === "object" && value !== null) {
    seen.delete(value);
  }

  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }

  if (typeof value === "symbol") {
    return value.toString();
  }

  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }

  return value;
}

export function sanitizeProviderOptions(
  providerOptions: unknown,
  reservedKeys: ReadonlySet<string>
): Record<string, unknown> | undefined {
  if (!isRecord(providerOptions)) {
    return undefined;
  }

  let comparableReservedKeys: Set<string>;
  try {
    comparableReservedKeys = new Set(
      Array.from(reservedKeys).map((key) => toComparableOptionKey(key))
    );
  } catch {
    comparableReservedKeys = new Set<string>();
  }

  const seen = new WeakSet<object>();
  const sanitizedEntries = new Map<string, unknown>();
  let entries: [string, unknown][];
  try {
    entries = Object.entries(providerOptions);
  } catch {
    return undefined;
  }

  for (const [rawKey, value] of entries) {
    const normalizedKey = normalizeOptionKey(rawKey);
    if (normalizedKey.length === 0) {
      continue;
    }
    const comparableKey = normalizedKey.toLowerCase();
    if (
      comparableReservedKeys.has(comparableKey) ||
      UNSAFE_OPTION_KEYS.has(comparableKey)
    ) {
      continue;
    }
    sanitizedEntries.set(normalizedKey, sanitizeOptionValue(value, seen, 0));
  }

  if (sanitizedEntries.size === 0) {
    return undefined;
  }

  return Object.fromEntries(sanitizedEntries);
}
