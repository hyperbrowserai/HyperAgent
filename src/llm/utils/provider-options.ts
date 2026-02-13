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
    const sanitized = Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !UNSAFE_OPTION_KEYS.has(key))
        .map(([key, entry]) => [key, sanitizeOptionValue(entry, seen)])
    );
    seen.delete(value);
    return sanitized;
  }

  if (typeof value === "object" && value !== null) {
    seen.delete(value);
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

  const seen = new WeakSet<object>();
  const sanitizedEntries = Object.entries(providerOptions).filter(
    ([key]) => !reservedKeys.has(key) && !UNSAFE_OPTION_KEYS.has(key)
  );

  if (sanitizedEntries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    sanitizedEntries.map(([key, value]) => [key, sanitizeOptionValue(value, seen)])
  );
}
