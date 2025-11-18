import { performance } from "perf_hooks";
import { ActionContext, ActionOutput } from "@/types";
import type { ResolvedCDPElement, CDPActionMethod } from "@/cdp";
import { isEncodedId, type EncodedId } from "@/context-providers/a11y-dom/types";
import { getElementLocator } from "../../shared/element-locator";
import { executePlaywrightMethod } from "../../shared/execute-playwright-method";

export interface PerformActionParams {
  elementId: string;
  method: string;
  arguments?: string[];
  instruction: string;
  confidence?: number;
}

/**
 * Performs a single action on an element
 * Consolidates logic for choosing between CDP and Playwright execution paths
 */
export async function performAction(
  ctx: ActionContext,
  params: PerformActionParams
): Promise<ActionOutput> {
  const {
    instruction,
    elementId,
    method,
    arguments: methodArgs = [],
    confidence,
  } = params;

  if (!isEncodedId(elementId)) {
    return {
      success: false,
      message: `Failed to execute "${instruction}": elementId "${elementId}" is not in encoded format (frameIndex-backendNodeId).`,
    };
  }

  const encodedId = elementId;
  const elementMetadata = ctx.domState.elements.get(encodedId);
  if (!elementMetadata) {
    return {
      success: false,
      message: `Failed to execute "${instruction}": elementId "${elementId}" not present in current DOM.`,
    };
  }

  const timings: Record<string, number> | undefined = ctx.debug ? {} : undefined;
  const debugInfo =
    ctx.debug && elementMetadata
      ? {
          requestedAction: {
            elementId,
            method,
            arguments: methodArgs,
            confidence,
            instruction,
          },
          elementMetadata,
          ...(timings ? { timings } : {}),
        }
      : undefined;

  const shouldUseCDP =
    !!ctx.cdp && ctx.cdpActions !== false && !!ctx.domState.backendNodeMap;

  if (shouldUseCDP) {
    const resolvedElementsCache = new Map<EncodedId, ResolvedCDPElement>();
    try {
      const resolveStart = performance.now();
      const resolved = await ctx.cdp!.resolveElement(encodedId, {
        page: ctx.page,
        cdpClient: ctx.cdp!.client,
        backendNodeMap: ctx.domState.backendNodeMap,
        xpathMap: ctx.domState.xpathMap,
        frameMap: ctx.domState.frameMap,
        resolvedElementsCache,
        frameContextManager: ctx.cdp!.frameContextManager,
        debug: ctx.debug,
        strictFrameValidation: true,
      });
      if (timings) {
        timings.resolveElementMs = Math.round(performance.now() - resolveStart);
      }

      const dispatchStart = performance.now();
      await ctx.cdp!.dispatchCDPAction(method as CDPActionMethod, methodArgs, {
        element: {
          ...resolved,
          xpath: ctx.domState.xpathMap?.[encodedId],
        },
        boundingBox: ctx.domState.boundingBoxMap?.get(encodedId) ?? undefined,
        preferScriptBoundingBox: ctx.cdp!.preferScriptBoundingBox,
        debug: ctx.cdp?.debug ?? ctx.debug,
      });
      if (timings) {
        timings.dispatchMs = Math.round(performance.now() - dispatchStart);
      }

      return {
        success: true,
        message: `Successfully executed: ${instruction}`,
        debug: debugInfo,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `Failed to execute "${instruction}": ${errorMessage}`,
        debug: debugInfo,
      };
    }
  }

  try {
    // Get Playwright locator using shared utility
    const locatorStart = performance.now();
    const { locator } = await getElementLocator(
      elementId,
      ctx.domState.xpathMap,
      ctx.page,
      ctx.domState.frameMap,
      !!ctx.debugDir
    );
    if (timings) {
      timings.locatorMs = Math.round(performance.now() - locatorStart);
    }

    // Execute Playwright method using shared utility
    const pwStart = performance.now();
    await executePlaywrightMethod(method, methodArgs, locator, {
      clickTimeout: 3500,
      debug: !!ctx.debugDir,
    });
    if (timings) {
      timings.playwrightActionMs = Math.round(performance.now() - pwStart);
    }

    return {
      success: true,
      message: `Successfully executed: ${instruction}`,
      debug: debugInfo,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Failed to execute "${instruction}": ${errorMessage}`,
      debug: debugInfo,
    };
  }
}

