import crypto from "crypto";

export function sha256(value: string): string {
  const hasher = crypto.createHash("sha256");
  hasher.update(value, "utf8");
  return hasher.digest("hex");
}

export function stableStringify(
  value: unknown,
  seen: WeakSet<object> = new WeakSet()
): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";

  const type = typeof value;
  if (type === "number") {
    if (!Number.isFinite(value as number)) {
      return JSON.stringify(String(value));
    }
    return JSON.stringify(value);
  }
  if (type === "bigint") {
    return JSON.stringify(`${value.toString()}n`);
  }
  if (type === "boolean" || type === "string") {
    return JSON.stringify(value);
  }
  if (type === "symbol") {
    return JSON.stringify((value as symbol).toString());
  }
  if (type === "function") {
    const name = (value as Function).name || "anonymous";
    return JSON.stringify(`[Function ${name}]`);
  }

  // Objects / arrays
  if (seen.has(value as object)) {
    return "\"[Circular]\"";
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    const items = value.map((entry) => stableStringify(entry, seen));
    return `[${items.join(",")}]`;
  }

  const entries = Object.keys(value as Record<string, unknown>).sort();
  const serialized = entries
    .map((key) => {
      const typed = value as Record<string, unknown>;
      return `${JSON.stringify(key)}:${stableStringify(typed[key], seen)}`;
    })
    .join(",");

  return `{${serialized}}`;
}
