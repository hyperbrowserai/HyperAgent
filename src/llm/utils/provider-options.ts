function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sanitizeProviderOptions(
  providerOptions: unknown,
  reservedKeys: ReadonlySet<string>
): Record<string, unknown> | undefined {
  if (!isRecord(providerOptions)) {
    return undefined;
  }

  const sanitizedEntries = Object.entries(providerOptions).filter(
    ([key]) => !reservedKeys.has(key)
  );

  if (sanitizedEntries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(sanitizedEntries);
}
