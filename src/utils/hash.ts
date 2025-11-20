import crypto from "crypto";

export function sha256(value: string): string {
  const hasher = crypto.createHash("sha256");
  hasher.update(value, "utf8");
  return hasher.digest("hex");
}
