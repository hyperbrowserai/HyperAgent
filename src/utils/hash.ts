import crypto from "crypto";

export function sha256(value: string): string {
  const hasher = crypto.createHash("sha256");
  hasher.update(value, "utf8");
  return hasher.digest("hex");
}

export function stableStringify(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (value === undefined) {
    return "undefined";
  }

  if (typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const entries = Object.keys(value as Record<string, unknown>).sort();
  const serialized = entries
    .map((key) => {
      const typed = value as Record<string, unknown>;
      return `${JSON.stringify(key)}:${stableStringify(typed[key])}`;
    })
    .join(",");

  return `{${serialized}}`;
}
