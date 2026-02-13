import { ActionOutput, ActionType } from "@/types";
import { ActionCacheEntry } from "@/types/agent/types";
import {
  A11yDOMState,
  asEncodedId,
} from "@/context-providers/a11y-dom/types";
import { formatUnknownError } from "@/utils";

const TEXT_NODE_SUFFIX = /\/text\(\)(\[\d+\])?$/iu;

const isString = (value: unknown): value is string =>
  typeof value === "string";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const safeReadRecordField = (
  value: Record<string, unknown>,
  key: string
): unknown => {
  try {
    return value[key];
  } catch {
    return undefined;
  }
};

const safeReadActionField = (
  action: ActionType,
  key: "type" | "params"
): unknown => {
  try {
    return (action as unknown as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
};

const safeReadActionOutputField = (
  actionOutput: ActionOutput,
  key: keyof ActionOutput
): unknown => {
  try {
    return (actionOutput as unknown as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
};

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

const getActionParamsRecord = (action: ActionType): Record<string, unknown> =>
  isRecord(safeReadActionField(action, "params"))
    ? (safeReadActionField(action, "params") as Record<string, unknown>)
    : {};

const extractInstruction = (action: ActionType): string | undefined => {
  const actionType = safeReadActionField(action, "type");
  const params = getActionParamsRecord(action);
  switch (actionType) {
    case "extract":
      return isString(params.objective) ? params.objective : undefined;
    case "actElement":
      return isString(params.instruction) ? params.instruction : undefined;
    default:
      // Actions like goToUrl, refreshPage, wait, analyzePdf do not require an instruction
      return isString(params.instruction) ? params.instruction : undefined;
  }
};

const extractElementId = (action: ActionType): string | null => {
  const params = getActionParamsRecord(action);
  if (isString(params.elementId)) {
    return params.elementId;
  }
  return null;
};

const extractMethod = (action: ActionType): string | null => {
  const params = getActionParamsRecord(action);
  if (isString(params.method)) {
    return params.method;
  }
  return null;
};

const extractArguments = (action: ActionType): string[] => {
  const params = getActionParamsRecord(action);
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
  const debugValue = safeReadActionOutputField(actionOutput, "debug");
  const debug = debugValue as Record<string, unknown> | undefined;
  if (!debug || typeof debug !== "object") {
    return null;
  }

  const metadata = safeReadRecordField(
    debug,
    "elementMetadata"
  ) as Record<string, unknown> | undefined;
  const xpath = metadata ? safeReadRecordField(metadata, "xpath") : undefined;
  if (isString(xpath)) {
    return xpath;
  }
  return null;
};

const extractXPathFromDomState = (
  domState: A11yDOMState,
  encodedId: string | undefined
): string | null => {
  if (!encodedId) {
    return null;
  }
  let xpathMap: unknown;
  try {
    xpathMap = domState.xpathMap;
  } catch {
    return null;
  }
  if (!xpathMap || typeof xpathMap !== "object") {
    return null;
  }
  try {
    const xpath = (xpathMap as Record<string, unknown>)[encodedId];
    return isString(xpath) ? xpath : null;
  } catch {
    return null;
  }
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
  const actionTypeValue = safeReadActionField(action, "type");
  const actionType =
    isString(actionTypeValue) && actionTypeValue.length > 0
      ? actionTypeValue
      : "unknown";
  const instruction = extractInstruction(action);
  const elementId = extractElementId(action);
  const method = extractMethod(action);
  const args = extractArguments(action);
  const encodedId = elementId ? asEncodedId(elementId) : undefined;
  const frameIndex = extractFrameIndex(elementId);

  // Normalize goToUrl to use arguments[0] for URL to simplify replay paths
  let normalizedArgs = args;
  const actionParamsValue = safeReadActionField(action, "params");
  const actionParamsRecord = isRecord(actionParamsValue)
    ? actionParamsValue
    : undefined;
  if (
    actionType === "goToUrl" &&
    (!args || args.length === 0) &&
    typeof actionParamsRecord?.url === "string"
  ) {
    normalizedArgs = [actionParamsRecord.url];
  }

  const xpathFromDom = extractXPathFromDomState(domState, encodedId);
  const xpath = normalizeXPath(
    xpathFromDom || extractXPathFromDebug(actionOutput)
  );
  const successValue = safeReadActionOutputField(actionOutput, "success");
  const messageValue = safeReadActionOutputField(actionOutput, "message");

  return {
    stepIndex,
    instruction,
    elementId,
    method,
    arguments: normalizedArgs,
    actionParams: actionParamsRecord,
    frameIndex,
    xpath,
    actionType,
    success: typeof successValue === "boolean" ? successValue : false,
    message:
      typeof messageValue === "string"
        ? messageValue
        : formatUnknownError(messageValue),
  };
};
