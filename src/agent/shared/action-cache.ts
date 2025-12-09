import { ActionOutput, ActionType } from "@/types";
import { ActionCacheEntry } from "@/types/agent/types";
import {
  A11yDOMState,
  asEncodedId,
} from "@/context-providers/a11y-dom/types";

const TEXT_NODE_SUFFIX = /\/text\(\)(\[\d+\])?$/iu;

const isString = (value: unknown): value is string =>
  typeof value === "string";

const isStringOrNumberArray = (
  value: unknown
): value is Array<string | number> =>
  Array.isArray(value) &&
  value.every((item) => typeof item === "string" || typeof item === "number");

const normalizeXPath = (raw?: string | null): string | null => {
  if (!raw) {
    return null;
  }
  return raw.replace(TEXT_NODE_SUFFIX, "");
};

const extractInstruction = (action: ActionType): string => {
  const params = action.params as Record<string, unknown>;
  if (isString(params.instruction)) {
    return params.instruction;
  }
  return action.type;
};

const extractElementId = (action: ActionType): string | null => {
  const params = action.params as Record<string, unknown>;
  if (isString(params.elementId)) {
    return params.elementId;
  }
  return null;
};

const extractMethod = (action: ActionType): string | null => {
  const params = action.params as Record<string, unknown>;
  if (isString(params.method)) {
    return params.method;
  }
  return null;
};

const extractArguments = (action: ActionType): string[] => {
  const params = action.params as Record<string, unknown>;
  if (isStringOrNumberArray(params.arguments)) {
    return params.arguments.map((item) => item.toString());
  }
  return [];
};

const extractFrameIndex = (elementId: string | null): number | null => {
  if (!elementId) {
    return null;
  }
  const encodedId = asEncodedId(elementId);
  if (!encodedId) {
    return null;
  }
  const [framePart] = encodedId.split("-");
  const parsed = Number.parseInt(framePart, 10);
  return Number.isNaN(parsed) ? null : parsed;
};

const extractXPathFromDebug = (actionOutput: ActionOutput): string | null => {
  const debug = actionOutput.debug as Record<string, unknown> | undefined;
  if (!debug || typeof debug !== "object") {
    return null;
  }

  const metadata = debug.elementMetadata as Record<string, unknown> | undefined;
  if (metadata && isString(metadata.xpath)) {
    return metadata.xpath;
  }
  return null;
};

export const buildActionCacheEntry = ({
  stepIndex,
  action,
  actionOutput,
  domState,
}: {
  stepIndex: number;
  action: ActionType;
  actionOutput: ActionOutput;
  domState: A11yDOMState;
}): ActionCacheEntry => {
  const instruction = extractInstruction(action);
  const elementId = extractElementId(action);
  const method = extractMethod(action);
  const args = extractArguments(action);
  const encodedId = elementId ? asEncodedId(elementId) : undefined;
  const frameIndex = extractFrameIndex(elementId);

  // Normalize goToUrl to use arguments[0] for URL to simplify replay paths
  let normalizedArgs = args;
  if (
    action.type === "goToUrl" &&
    (!args || args.length === 0) &&
    action.params &&
    typeof (action.params as any).url === "string"
  ) {
    normalizedArgs = [(action.params as any).url as string];
  }

  const xpathFromDom = encodedId ? domState.xpathMap?.[encodedId] || null : null;
  const xpath = normalizeXPath(
    xpathFromDom || extractXPathFromDebug(actionOutput)
  );

  return {
    stepIndex,
    instruction,
    elementId,
    method,
    arguments: normalizedArgs,
    actionParams: (action.params as Record<string, unknown>) || undefined,
    frameIndex,
    xpath,
    actionType: action.type,
    success: actionOutput.success,
    message: actionOutput.message,
  };
};
