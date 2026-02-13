function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UNSAFE_OPTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function sanitizeOptionValue(
  value: unknown,
  seen: WeakSet<object>
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeOptionValue(entry, seen));
  }

  if (isRecord(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);
    const sanitized = Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !UNSAFE_OPTION_KEYS.has(key))
        .map(([key, entry]) => [key, sanitizeOptionValue(entry, seen)])
    );
    seen.delete(value);
    return sanitized;
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
