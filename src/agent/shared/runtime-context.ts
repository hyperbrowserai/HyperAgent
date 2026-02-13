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

/**
 * Initialize shared runtime context for agent operations
 * Handles CDP client acquisition and frame manager initialization
 */
export async function initializeRuntimeContext(
  page: Page,
  debug: boolean = false
): Promise<RuntimeContext> {
  if (!page || typeof page !== "object") {
    throw new Error("[FrameContext] Invalid page instance for runtime initialization");
  }

  let cdpClient: CDPClient;
  try {
    cdpClient = await getCDPClient(page);
  } catch (error) {
    throw new Error(
      `[FrameContext] Failed to acquire CDP client: ${formatUnknownError(error)}`
    );
  }

  let frameContextManager: FrameContextManager;
  try {
    frameContextManager = getOrCreateFrameContextManager(cdpClient);
  } catch (error) {
    throw new Error(
      `[FrameContext] Failed to create frame context manager: ${formatUnknownError(error)}`
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
      frameContextManager.setDebug(debug);
    }
    await frameContextManager.ensureInitialized();
  } catch (error) {
    if (debug) {
      console.warn(
        "[FrameContext] Failed to initialize frame context manager:",
        formatUnknownError(error)
      );
    }
    throw new Error(
      `[FrameContext] Failed to initialize frame context manager: ${formatUnknownError(error)}`
    );
  }

  return {
    cdpClient,
    frameContextManager,
  };
}

