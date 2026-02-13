function stringifyUnknownObject(value: object): string {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (_key, candidate: unknown) => {
    if (typeof candidate === "bigint") {
      return `${candidate.toString()}n`;
    }
    if (typeof candidate === "object" && candidate !== null) {
      if (seen.has(candidate)) {
        return "[Circular]";
      }
      seen.add(candidate);
    }
    return candidate;
  });
  return serialized ?? String(value);
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message?.trim();
    return message && message.length > 0 ? message : error.name;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    try {
      return stringifyUnknownObject(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}
