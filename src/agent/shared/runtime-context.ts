import type { Page } from "playwright-core";
import {
  getCDPClient,
  getOrCreateFrameContextManager,
} from "@/cdp";
import type { CDPClient } from "@/cdp/types";
import type { FrameContextManager } from "@/cdp/frame-context-manager";

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
  try {
    const cdpClient = await getCDPClient(page);
    const frameContextManager = getOrCreateFrameContextManager(cdpClient);
    
    frameContextManager.setDebug(debug);
    await frameContextManager.ensureInitialized();
    
    return {
      cdpClient,
      frameContextManager
    };
  } catch (error) {
    if (debug) {
      console.warn(
        "[FrameContext] Failed to initialize frame context manager:",
        error
      );
    }
    // Re-throw or handle as needed - consistent with previous ensureFrameContextsReady behavior
    // but now we probably want the caller to know initialization failed if it's critical
    throw error;
  }
}

