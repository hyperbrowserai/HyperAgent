import type { Page } from "playwright-core";
import { performance } from "perf_hooks";

import {
  getA11yDOM,
  type A11yDOMState,
} from "@/context-providers/a11y-dom";
import type { FrameChunkEvent } from "@/context-providers/a11y-dom/types";
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
  if (snapshot.elements.size > 0) return false;
  return (
    typeof snapshot.domState === "string" &&
    snapshot.domState.startsWith("Error: Could not extract accessibility tree")
  );
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
  } = options;

  let lastError: unknown;
  const domFetchStart = performance.now();

  for (let attempt = 0; attempt < maxRetries; attempt++) {
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
          onFrameChunk: attemptAggregator
            ? (chunk) => {
                attemptAggregator.push(chunk);
                onFrameChunk?.(chunk);
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
        const domDuration = performance.now() - domFetchStart;
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
        `[DOM] Capture failed (attempt ${attempt + 1}/${maxRetries}), waiting for navigation to settle...`
      );
    }
    
    // Wait for DOM to settle before next retry
    await waitForSettledDOM(page).catch(() => {});
  }

  throw lastError ?? new Error(`Failed to capture DOM state after ${maxRetries} attempts`);
}

