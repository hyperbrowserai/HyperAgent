const MAX_SAFE_JSON_PARSE_CHARS = 100_000;

export function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.replace(/^\uFEFF/, "").trim();
  if (normalized.length === 0) {
    return value;
  }
  if (normalized.length > MAX_SAFE_JSON_PARSE_CHARS) {
    return value;
  }
  try {
    return JSON.parse(normalized);
  } catch {
    return value;
  }
}
