import { sleep } from "./sleep";
import { formatUnknownError } from "./format-unknown-error";

const DEFAULT_RETRY_COUNT = 3;
const MAX_RETRY_COUNT = 10;
const MAX_RETRY_DELAY_MS = 10_000;
const MAX_RETRY_DIAGNOSTIC_CHARS = 300;

function formatRetryDiagnostic(value: unknown): string {
  const normalized = Array.from(formatUnknownError(value), (char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code < 32) || code === 127 ? " " : char;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = normalized.length > 0 ? normalized : "unknown error";
  if (fallback.length <= MAX_RETRY_DIAGNOSTIC_CHARS) {
    return fallback;
  }
  const omittedChars = fallback.length - MAX_RETRY_DIAGNOSTIC_CHARS;
  return `${fallback.slice(0, MAX_RETRY_DIAGNOSTIC_CHARS)}... [truncated ${omittedChars} chars]`;
}

function normalizeRetryCount(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_RETRY_COUNT;
  }
  if (value <= 0) {
    return DEFAULT_RETRY_COUNT;
  }
  return Math.min(Math.floor(value), MAX_RETRY_COUNT);
}

export async function retry<T>({
  func,
  params,
  onError,
}: {
  func: () => Promise<T>;
  params?: { retryCount?: number };
  onError?: (...err: Array<unknown>) => void;
}): Promise<T> {
  let lastError: unknown = new Error("Retry operation failed");
  const retryCount = normalizeRetryCount(params?.retryCount);
  for (let attempt = 0; attempt < retryCount; attempt++) {
    try {
      const resp = await func();
      return resp;
    } catch (error) {
      try {
        onError?.(`Retry Attempt ${attempt + 1}/${retryCount}`, error);
      } catch (handlerError) {
        console.warn(
          `[retry] onError handler failed: ${formatRetryDiagnostic(handlerError)}`
        );
      }
      lastError = error;
      if (attempt < retryCount - 1) {
        const delayMs = Math.min(Math.pow(2, attempt) * 1000, MAX_RETRY_DELAY_MS);
        try {
          await sleep(delayMs);
        } catch (sleepError) {
          console.warn(
            `[retry] sleep failed: ${formatRetryDiagnostic(sleepError)}`
          );
        }
      }
    }
  }
  throw lastError;
}
