import { sleep } from "./sleep";
import { formatUnknownError } from "./format-unknown-error";

const DEFAULT_RETRY_COUNT = 3;
const MAX_RETRY_COUNT = 10;

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
          `[retry] onError handler failed: ${formatUnknownError(handlerError)}`
        );
      }
      lastError = error;
      if (attempt < retryCount - 1) {
        await sleep(Math.pow(2, attempt) * 1000);
      }
    }
  }
  throw lastError;
}
