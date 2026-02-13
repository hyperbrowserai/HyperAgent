function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const UNSAFE_OPTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function normalizeOptionKey(key: string): string {
  return key.trim();
}

function toComparableOptionKey(key: string): string {
  return normalizeOptionKey(key).toLowerCase();
}

function sanitizeOptionValue(
  value: unknown,
  seen: WeakSet<object>
): unknown {
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
  }

  if (Array.isArray(value)) {
    const sanitizedArray = value.map((entry) => sanitizeOptionValue(entry, seen));
    seen.delete(value);
    return sanitizedArray;
  }

  if (isPlainRecord(value)) {
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
      sanitizedEntries.set(normalizedKey, sanitizeOptionValue(entry, seen));
    }
    const sanitized = Object.fromEntries(sanitizedEntries);
    seen.delete(value);
    return sanitized;
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

  const comparableReservedKeys = new Set(
    Array.from(reservedKeys).map((key) => toComparableOptionKey(key))
  );
  const seen = new WeakSet<object>();
  const sanitizedEntries = new Map<string, unknown>();

  for (const [rawKey, value] of Object.entries(providerOptions)) {
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
    sanitizedEntries.set(normalizedKey, sanitizeOptionValue(value, seen));
  }

  if (sanitizedEntries.size === 0) {
    return undefined;
  }

  return Object.fromEntries(sanitizedEntries);
}
