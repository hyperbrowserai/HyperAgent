import type { Page } from "playwright-core";
import { performance } from "perf_hooks";

import {
  getA11yDOM,
  type A11yDOMState,
} from "@/context-providers/a11y-dom";
import type { FrameChunkEvent } from "@/context-providers/a11y-dom/types";
import { formatUnknownError } from "@/utils";
import { waitForSettledDOM } from "@/utils/waitForSettledDOM";

const DOM_CAPTURE_MAX_ATTEMPTS = 3;
const NAVIGATION_ERROR_SNIPPETS = [
  "Execution context was destroyed",
  "Cannot find context",
  "Target closed",
];

export interface CaptureDOMOptions {
  useCache?: boolean;
  debug?: boolean;
  enableVisualMode?: boolean;
  debugStepDir?: string;
  enableStreaming?: boolean;
  onFrameChunk?: (chunk: FrameChunkEvent) => void;
  maxRetries?: number;
  filterAdTrackingFrames?: boolean;
}

const MAX_DOM_CAPTURE_RETRIES = 10;
const MAX_DOM_CAPTURE_DIAGNOSTIC_CHARS = 400;

function sanitizeDomCaptureText(value: string): string {
  if (value.length === 0) {
    return value;
  }
  const withoutControlChars = Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code < 32) || code === 127 ? " " : char;
  }).join("");
  return withoutControlChars.replace(/\s+/g, " ").trim();
}

function truncateDomCaptureDiagnostic(value: string): string {
  if (value.length <= MAX_DOM_CAPTURE_DIAGNOSTIC_CHARS) {
    return value;
  }
  const omittedChars = value.length - MAX_DOM_CAPTURE_DIAGNOSTIC_CHARS;
  return `${value.slice(0, MAX_DOM_CAPTURE_DIAGNOSTIC_CHARS)}... [truncated ${omittedChars} chars]`;
}

function formatDomCaptureDiagnostic(value: unknown): string {
  const normalized = sanitizeDomCaptureText(formatUnknownError(value));
  if (normalized.length === 0) {
    return "unknown callback error";
  }
  return truncateDomCaptureDiagnostic(normalized);
}

class DomChunkAggregator {
  private parts: string[] = [];
  private pending = new Map<number, FrameChunkEvent>();
  private nextOrder = 0;

  push(chunk: FrameChunkEvent): void {
    this.pending.set(chunk.order, chunk);
    this.flush();
  }

  private flush(): void {
    while (true) {
      const chunk = this.pending.get(this.nextOrder);
      if (!chunk) break;
      this.pending.delete(this.nextOrder);
      this.parts.push(chunk.simplified.trim());
      this.nextOrder += 1;
    }
  }

  hasContent(): boolean {
    return this.parts.length > 0;
  }

  toString(): string {
    return this.parts.join("\n\n");
  }
}

const isRecoverableDomError = (error: unknown): boolean => {
  if (!(error instanceof Error) || !error.message) {
    return false;
  }
  return NAVIGATION_ERROR_SNIPPETS.some((snippet) =>
    error.message.includes(snippet)
  );
};

const isPlaceholderSnapshot = (snapshot: A11yDOMState): boolean => {
  try {
    if (!snapshot || typeof snapshot !== "object") return false;
    if (!(snapshot.elements instanceof Map)) return false;
    if (snapshot.elements.size > 0) return false;
    return (
      typeof snapshot.domState === "string" &&
      snapshot.domState.startsWith("Error: Could not extract accessibility tree")
    );
  } catch {
    return false;
  }
};

function logPerf(
  debug: boolean | undefined,
  label: string,
  start: number
): void {
  if (!debug) return;
  const duration = performance.now() - start;
  console.log(`${label} took ${Math.round(duration)}ms`);
}

/**
 * Capture DOM state with retry logic for stability
 * Handles navigation races, execution context destruction, and placeholder snapshots
 */
export async function captureDOMState(
  page: Page,
  options: CaptureDOMOptions = {}
): Promise<A11yDOMState> {
  const {
    useCache = false,
    debug = false,
    enableVisualMode = false,
    debugStepDir,
    enableStreaming = false,
    onFrameChunk,
    maxRetries = DOM_CAPTURE_MAX_ATTEMPTS,
    filterAdTrackingFrames,
  } = options;
  const normalizedMaxRetries =
    typeof maxRetries === "number" &&
    Number.isFinite(maxRetries) &&
    maxRetries > 0
      ? Math.min(Math.floor(maxRetries), MAX_DOM_CAPTURE_RETRIES)
      : DOM_CAPTURE_MAX_ATTEMPTS;

  let lastError: unknown;
  const domFetchStart = performance.now();

  for (let attempt = 0; attempt < normalizedMaxRetries; attempt++) {
    const attemptAggregator = enableStreaming
      ? new DomChunkAggregator()
      : null;

    try {
      const snapshot = await getA11yDOM(
        page,
        debug,
        enableVisualMode,
        debugStepDir,
        {
          useCache,
          enableStreaming,
          filterAdTrackingFrames,
          onFrameChunk: attemptAggregator
            ? (chunk) => {
                attemptAggregator.push(chunk);
                if (!onFrameChunk) return;
                try {
                  onFrameChunk(chunk);
                } catch (error) {
                  if (debug) {
                    console.warn(
                      `[DOM] onFrameChunk callback failed: ${formatDomCaptureDiagnostic(
                        error
                      )}`
                    );
                  }
                }
              }
            : undefined,
        }
      );

      if (!snapshot) {
        throw new Error("Failed to capture DOM state");
      }

      if (isPlaceholderSnapshot(snapshot)) {
        lastError = new Error(snapshot.domState);
      } else {
        logPerf(debug, `[Perf][captureDOMState] success (attempt ${attempt + 1})`, domFetchStart);
        
        // If we were streaming, update the full string in the snapshot
        if (attemptAggregator?.hasContent()) {
          snapshot.domState = attemptAggregator.toString();
        }
        
        return snapshot;
      }
    } catch (error) {
      if (!isRecoverableDomError(error)) {
        throw error;
      }
      lastError = error;
    }

    if (debug) {
      console.warn(
        `[DOM] Capture failed (attempt ${attempt + 1}/${normalizedMaxRetries}), waiting for navigation to settle...`
      );
    }
    
    // Wait for DOM to settle before next retry
    await waitForSettledDOM(page, undefined, {
      filterAdTrackingFrames,
    }).catch(() => {});
  }

  throw (
    lastError ??
    new Error(`Failed to capture DOM state after ${normalizedMaxRetries} attempts`)
  );
}

