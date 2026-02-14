import type { Page } from "playwright-core";
import {
  getCDPClient,
  getOrCreateFrameContextManager,
} from "@/cdp";
import type { CDPClient } from "@/cdp/types";
import type { FrameContextManager } from "@/cdp/frame-context-manager";
import { formatUnknownError } from "@/utils";

export interface RuntimeContext {
  cdpClient: CDPClient;
  frameContextManager: FrameContextManager;
}

export interface RuntimeContextOptions {
  filterAdTrackingFrames?: boolean;
}

const MAX_RUNTIME_CONTEXT_DIAGNOSTIC_CHARS = 400;

function formatRuntimeContextDiagnostic(value: unknown): string {
  const normalized = Array.from(formatUnknownError(value), (char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code < 32) || code === 127 ? " " : char;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = normalized.length > 0 ? normalized : "unknown error";
  if (fallback.length <= MAX_RUNTIME_CONTEXT_DIAGNOSTIC_CHARS) {
    return fallback;
  }
  const omitted = fallback.length - MAX_RUNTIME_CONTEXT_DIAGNOSTIC_CHARS;
  return `${fallback.slice(
    0,
    MAX_RUNTIME_CONTEXT_DIAGNOSTIC_CHARS
  )}... [truncated ${omitted} chars]`;
}

/**
 * Initialize shared runtime context for agent operations
 * Handles CDP client acquisition and frame manager initialization
 */
export async function initializeRuntimeContext(
  page: Page,
  debug: boolean = false,
  options: RuntimeContextOptions = {}
): Promise<RuntimeContext> {
  if (!page || typeof page !== "object") {
    throw new Error("[FrameContext] Invalid page instance for runtime initialization");
  }

  let cdpClient: CDPClient;
  try {
    cdpClient = await getCDPClient(page);
  } catch (error) {
    throw new Error(
      `[FrameContext] Failed to acquire CDP client: ${formatRuntimeContextDiagnostic(
        error
      )}`
    );
  }

  let frameContextManager: FrameContextManager;
  try {
    frameContextManager = getOrCreateFrameContextManager(cdpClient);
  } catch (error) {
    throw new Error(
      `[FrameContext] Failed to create frame context manager: ${formatRuntimeContextDiagnostic(
        error
      )}`
    );
  }

  if (
    !frameContextManager ||
    typeof frameContextManager.ensureInitialized !== "function"
  ) {
    throw new Error(
      "[FrameContext] Invalid frame context manager: ensureInitialized() is unavailable"
    );
  }

  try {
    if (typeof frameContextManager.setDebug === "function") {
      try {
        frameContextManager.setDebug(debug);
      } catch (error) {
        if (debug) {
          console.warn(
            `[FrameContext] Failed to configure frame manager debug: ${formatRuntimeContextDiagnostic(
              error
            )}`
          );
        }
      }
    }
    if (
      typeof frameContextManager.setFrameFilteringEnabled === "function" &&
      typeof options.filterAdTrackingFrames === "boolean"
    ) {
      try {
        frameContextManager.setFrameFilteringEnabled(
          options.filterAdTrackingFrames
        );
      } catch (error) {
        if (debug) {
          console.warn(
            `[FrameContext] Failed to configure frame filtering: ${formatRuntimeContextDiagnostic(
              error
            )}`
          );
        }
      }
    }
    await frameContextManager.ensureInitialized();
  } catch (error) {
    const diagnostic = formatRuntimeContextDiagnostic(error);
    if (debug) {
      console.warn(
        "[FrameContext] Failed to initialize frame context manager:",
        diagnostic
      );
    }
    throw new Error(
      `[FrameContext] Failed to initialize frame context manager: ${diagnostic}`
    );
  }

  return {
    cdpClient,
    frameContextManager,
  };
}

