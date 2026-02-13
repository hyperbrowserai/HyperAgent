import { performance } from "perf_hooks";
import { ActionContext, ActionOutput } from "@/types";
import type { ResolvedCDPElement, CDPActionMethod } from "@/cdp";
import { isEncodedId, type EncodedId } from "@/context-providers/a11y-dom/types";
import { formatUnknownError } from "@/utils";
import { getElementLocator } from "../../shared/element-locator";
import { executePlaywrightMethod } from "../../shared/execute-playwright-method";

export interface PerformActionParams {
  elementId: string;
  method: string;
  arguments?: string[];
  instruction: string;
  confidence?: number;
}

const VARIABLE_TOKEN_PATTERN = /<<([^>]+)>>/g;
const MAX_ACTION_ARGS = 50;
const MAX_ACTION_ARG_CHARS = 20_000;
const MAX_ACTION_METHOD_CHARS = 128;
const MAX_ACTION_TEXT_CHARS = 1_000;

function safeReadRecordField(
  value: unknown,
  key: string
): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function normalizeTextInput(
  value: unknown,
  fallback: string,
  maxChars: number
): string {
  const source =
    typeof value === "string" ? value : value == null ? fallback : formatUnknownError(value);
  const normalized = source.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return fallback;
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}…`;
}

function normalizeMethodInput(value: unknown): string {
  return normalizeTextInput(value, "click", MAX_ACTION_METHOD_CHARS);
}

function normalizeActionArguments(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ACTION_ARGS).map((arg) =>
    normalizeTextInput(arg, "", MAX_ACTION_ARG_CHARS)
  );
}

function readVariables(ctx: ActionContext): Array<{ key: string; value: string }> {
  const rawVariables = safeReadRecordField(ctx, "variables");
  if (!Array.isArray(rawVariables)) {
    return [];
  }
  const normalized: Array<{ key: string; value: string }> = [];
  for (const entry of rawVariables) {
    const key = normalizeTextInput(
      safeReadRecordField(entry, "key"),
      "",
      MAX_ACTION_METHOD_CHARS
    );
    if (key.length === 0) {
      continue;
    }
    const value = normalizeTextInput(safeReadRecordField(entry, "value"), "", MAX_ACTION_ARG_CHARS);
    normalized.push({ key, value });
  }
  return normalized;
}

function buildFailureMessage(instruction: string, error: unknown): string {
  return `Failed to execute "${normalizeTextInput(
    instruction,
    "task",
    MAX_ACTION_TEXT_CHARS
  )}": ${normalizeTextInput(formatUnknownError(error), "unknown error", MAX_ACTION_TEXT_CHARS)}`;
}

function interpolateVariables(value: string, ctx: ActionContext): string {
  const variables = readVariables(ctx);
  return value.replace(VARIABLE_TOKEN_PATTERN, (match, key) => {
    const normalizedKey = key.trim();
    const variable = variables.find((entry) => entry.key === normalizedKey);
    return variable ? variable.value : match;
  });
}

/**
 * Performs a single action on an element
 * Consolidates logic for choosing between CDP and Playwright execution paths
 */
export async function performAction(
  ctx: ActionContext,
  params: PerformActionParams
): Promise<ActionOutput> {
  const instruction = normalizeTextInput(
    safeReadRecordField(params, "instruction"),
    "Execute action",
    MAX_ACTION_TEXT_CHARS
  );
  const elementId = normalizeTextInput(
    safeReadRecordField(params, "elementId"),
    "",
    MAX_ACTION_METHOD_CHARS
  );
  const method = normalizeMethodInput(safeReadRecordField(params, "method"));
  const confidence = safeReadRecordField(params, "confidence");
  const methodArgs = normalizeActionArguments(safeReadRecordField(params, "arguments"));
  const resolvedInstruction = interpolateVariables(instruction, ctx);
  const resolvedMethodArgs = methodArgs.map((arg) => interpolateVariables(arg, ctx));

  if (!isEncodedId(elementId)) {
    return {
      success: false,
      message: `Failed to execute "${resolvedInstruction}": elementId "${elementId}" is not in encoded format (frameIndex-backendNodeId).`,
    };
  }

  const domState = safeReadRecordField(ctx, "domState");
  const elements = safeReadRecordField(domState, "elements");
  if (!(elements instanceof Map)) {
    return {
      success: false,
      message: `Failed to execute "${resolvedInstruction}": current DOM elements are unavailable.`,
    };
  }

  const encodedId = elementId;
  let elementMetadata: unknown;
  try {
    elementMetadata = elements.get(encodedId);
  } catch (error) {
    return {
      success: false,
      message: buildFailureMessage(
        resolvedInstruction,
        `DOM element lookup failed: ${formatUnknownError(error)}`
      ),
    };
  }
  if (!elementMetadata) {
    return {
      success: false,
      message: `Failed to execute "${resolvedInstruction}": elementId "${elementId}" not present in current DOM.`,
    };
  }

  const isDebug = safeReadRecordField(ctx, "debug") === true;
  const debugDir = safeReadRecordField(ctx, "debugDir");
  const timings: Record<string, number> | undefined = isDebug ? {} : undefined;
  const debugInfo =
    isDebug && elementMetadata
      ? {
          requestedAction: {
            elementId,
            method,
            arguments: resolvedMethodArgs,
            confidence,
            instruction: resolvedInstruction,
          },
          elementMetadata,
          ...(timings ? { timings } : {}),
        }
      : undefined;

  const cdp = safeReadRecordField(ctx, "cdp");
  const cdpClient = safeReadRecordField(cdp, "client");
  const resolveElement = safeReadRecordField(cdp, "resolveElement");
  const dispatchCDPAction = safeReadRecordField(cdp, "dispatchCDPAction");
  const backendNodeMap = safeReadRecordField(domState, "backendNodeMap");
  const xpathMap = safeReadRecordField(domState, "xpathMap");
  const frameMap = safeReadRecordField(domState, "frameMap");
  const boundingBoxMap = safeReadRecordField(domState, "boundingBoxMap");
  const frameContextManager = safeReadRecordField(cdp, "frameContextManager");
  const preferScriptBoundingBox = safeReadRecordField(cdp, "preferScriptBoundingBox");
  const normalizedBackendNodeMap =
    backendNodeMap && typeof backendNodeMap === "object"
      ? (backendNodeMap as Record<string, number>)
      : undefined;
  const normalizedXpathMap =
    xpathMap && typeof xpathMap === "object"
      ? (xpathMap as Record<string, string>)
      : {};
  const normalizedFrameMap = frameMap instanceof Map ? frameMap : undefined;

  const shouldUseCDP =
    ctx.cdpActions !== false &&
    !!cdpClient &&
    typeof resolveElement === "function" &&
    typeof dispatchCDPAction === "function" &&
    !!normalizedBackendNodeMap;

  if (shouldUseCDP) {
    const resolvedElementsCache = new Map<EncodedId, ResolvedCDPElement>();
    try {
      const resolveStart = performance.now();
      const resolved = await resolveElement(encodedId, {
        page: ctx.page,
        cdpClient,
        backendNodeMap: normalizedBackendNodeMap,
        xpathMap: normalizedXpathMap,
        frameMap: normalizedFrameMap,
        resolvedElementsCache,
        frameContextManager: frameContextManager as unknown,
        debug: isDebug,
        strictFrameValidation: true,
      });
      if (timings) {
        timings.resolveElementMs = Math.round(performance.now() - resolveStart);
      }

      const dispatchStart = performance.now();
      await dispatchCDPAction(method as CDPActionMethod, resolvedMethodArgs, {
        element: {
          ...resolved,
          xpath: normalizedXpathMap[encodedId],
        },
        boundingBox:
          boundingBoxMap instanceof Map
            ? boundingBoxMap.get(encodedId) ?? undefined
            : undefined,
        preferScriptBoundingBox: preferScriptBoundingBox as boolean | undefined,
        debug: safeReadRecordField(cdp, "debug") ?? isDebug,
      });
      if (timings) {
        timings.dispatchMs = Math.round(performance.now() - dispatchStart);
      }

      return {
        success: true,
        message: `Successfully executed: ${resolvedInstruction}`,
        debug: debugInfo,
      };
    } catch (error) {
      return {
        success: false,
        message: buildFailureMessage(resolvedInstruction, error),
        debug: debugInfo,
      };
    }
  }

  try {
    // Get Playwright locator using shared utility
    const locatorStart = performance.now();
    const { locator } = await getElementLocator(
      elementId,
      normalizedXpathMap,
      ctx.page,
      normalizedFrameMap,
      typeof debugDir === "string" && debugDir.trim().length > 0
    );
    if (timings) {
      timings.locatorMs = Math.round(performance.now() - locatorStart);
    }

    // Execute Playwright method using shared utility
    const pwStart = performance.now();
    await executePlaywrightMethod(method, resolvedMethodArgs, locator, {
      clickTimeout: 3500,
      debug: typeof debugDir === "string" && debugDir.trim().length > 0,
    });
    if (timings) {
      timings.playwrightActionMs = Math.round(performance.now() - pwStart);
    }

    return {
      success: true,
      message: `Successfully executed: ${resolvedInstruction}`,
      debug: debugInfo,
    };
  } catch (error) {
    return {
      success: false,
      message: buildFailureMessage(resolvedInstruction, error),
      debug: debugInfo,
    };
  }
}

