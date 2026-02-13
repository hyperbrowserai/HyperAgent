import { sleep } from "./sleep";

const DEFAULT_RETRY_COUNT = 3;

function normalizeRetryCount(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_RETRY_COUNT;
  }
  return value > 0 ? Math.floor(value) : DEFAULT_RETRY_COUNT;
}

export async function retry<T>({
  func,
  params,
  onError,
}: {
  func: () => Promise<T>;
  params?: { retryCount: number };
  onError?: (...err: Array<unknown>) => void;
}): Promise<T> {
  let lastError: unknown = new Error("Retry operation failed");
  const retryCount = normalizeRetryCount(params?.retryCount);
  for (let attempt = 0; attempt < retryCount; attempt++) {
    try {
      const resp = await func();
      return resp;
    } catch (error) {
      onError?.(`Retry Attempt ${attempt + 1}/${retryCount}`, error);
      lastError = error;
      if (attempt < retryCount - 1) {
        await sleep(Math.pow(2, attempt) * 1000);
      }
    }
  }
  throw lastError;
}
