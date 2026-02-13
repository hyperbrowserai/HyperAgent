export function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.replace(/^\uFEFF/, "").trim();
  if (normalized.length === 0) {
    return value;
  }
  try {
    return JSON.parse(normalized);
  } catch {
    return value;
  }
}
