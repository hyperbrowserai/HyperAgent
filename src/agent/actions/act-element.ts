import { z } from "zod";
import { performance } from "perf_hooks";
import { ActionContext, ActionOutput, AgentActionDefinition } from "@/types";
import { executePlaywrightMethod } from "../shared/execute-playwright-method";
import { getElementLocator } from "../shared/element-locator";
import { AGENT_ELEMENT_ACTIONS } from "../shared/action-restrictions";
import type { EncodedId } from "@/context-providers/a11y-dom/types";
import { isEncodedId } from "@/context-providers/a11y-dom/types";
import type { CDPActionMethod, ResolvedCDPElement } from "@/cdp";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.object({}).catchall(jsonValueSchema),
  ]) as z.ZodType<JsonValue>
);

const methodSchema = z
  .enum(AGENT_ELEMENT_ACTIONS)
  .describe(
    "Method to execute (click, fill, type, press, selectOptionFromDropdown, check, uncheck, hover, scrollTo, nextChunk, prevChunk)."
  );

const ActElementAction = z
  .object({
    instruction: z
      .string()
      .describe(
        "Short explanation of why this action is needed."
      ),
    elementId: z
      .string()
      .min(1)
      .describe(
        'Encoded element identifier from the DOM listing (format "frameIndex-backendNodeId", e.g., "0-5125").'
      ),
    method: methodSchema.describe(
      "CDP/Playwright method to invoke (click, fill, type, press, selectOptionFromDropdown, check, uncheck, hover, scrollTo, nextChunk, prevChunk)."
    ),
    arguments: z
      .array(jsonValueSchema)
      .describe(
        "Arguments for the method (e.g., text to fill, key to press, scroll target). Use an empty array when no arguments are required."
      ),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe(
        "LLM-estimated confidence (0-1). Used for debugging/telemetry; execution does not depend on it."
      ),
  })
  .describe("Perform a single action on an element by referencing an encoded ID from the DOM listing.");

type ActElementActionType = z.infer<typeof ActElementAction>;

export const ActElementActionDefinition: AgentActionDefinition = {
  type: "actElement" as const,
  actionParams: ActElementAction,
  run: async function (
    ctx: ActionContext,
    action: ActElementActionType
  ): Promise<ActionOutput> {
    const {
      instruction,
      elementId,
      method,
      arguments: methodArgs = [],
      confidence,
    } = action;

    if (!isEncodedId(elementId)) {
      return {
        success: false,
        message: `Failed to execute "${instruction}": elementId "${elementId}" is not in encoded format (frameIndex-backendNodeId).`,
      };
    }

    const encodedId = elementId as EncodedId;
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
      !!ctx.actionConfig?.cdpActions &&
      !!ctx.cdp &&
      !!ctx.domState.backendNodeMap;

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
        clickTimeout: ctx.actionConfig?.clickElement?.timeout ?? 3500,
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
  },
  pprintAction: function (params: ActElementActionType): string {
    return `Act: ${params.instruction}`;
  },
};
