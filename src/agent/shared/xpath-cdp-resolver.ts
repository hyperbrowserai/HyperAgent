import { CDPClient } from "@/cdp/types";
import { FrameContextManager } from "@/cdp/frame-context-manager";
import { HyperagentError } from "../error";
import { formatUnknownError } from "@/utils";

const MAX_XPATH_CDP_DIAGNOSTIC_CHARS = 400;

export interface ResolvedCDPFromXPath {
  backendNodeId: number;
  frameId: string;
  objectId?: string;
}

export interface ResolveXPathWithCDPParams {
  xpath: string;
  frameIndex: number | null | undefined;
  cdpClient: CDPClient;
  frameContextManager?: FrameContextManager;
  debug?: boolean;
}

function formatXPathCDPDiagnostic(value: unknown): string {
  const normalized = Array.from(formatUnknownError(value), (char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code < 32) || code === 127 ? " " : char;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = normalized.length > 0 ? normalized : "unknown error";
  if (fallback.length <= MAX_XPATH_CDP_DIAGNOSTIC_CHARS) {
    return fallback;
  }
  const omitted = fallback.length - MAX_XPATH_CDP_DIAGNOSTIC_CHARS;
  return `${fallback.slice(
    0,
    MAX_XPATH_CDP_DIAGNOSTIC_CHARS
  )}... [truncated ${omitted} chars]`;
}

export async function resolveXPathWithCDP(
  params: ResolveXPathWithCDPParams
): Promise<ResolvedCDPFromXPath> {
  const { cdpClient, frameContextManager, debug } = params;
  const xpath = normalizeXPathInput(params.xpath);
  const normalizedFrameIndex = normalizeFrameIndex(params.frameIndex);

  // Use a DOM session without detaching the shared session; this keeps root session intact.
  let session: Awaited<ReturnType<CDPClient["acquireSession"]>>;
  try {
    session = await cdpClient.acquireSession("dom");
  } catch (error) {
    throw new HyperagentError(
      `Failed to acquire CDP session for XPath resolution: ${formatXPathCDPDiagnostic(
        error
      )}`,
      500
    );
  }
  const targetFrameId = resolveTargetFrameId(
    normalizedFrameIndex,
    frameContextManager
  );

  if (!targetFrameId) {
    throw new HyperagentError(
      `Unable to resolve frameId for frameIndex ${normalizedFrameIndex}. ${buildFrameDiagnostics(
        frameContextManager
      )}`,
      404
    );
  }

  const executionContextId = frameContextManager
    ? await safeWaitForExecutionContext(frameContextManager, targetFrameId)
    : undefined;

  if (frameContextManager && normalizedFrameIndex !== 0 && !executionContextId) {
    throw new HyperagentError(
      `Execution context missing for frameIndex ${normalizedFrameIndex} (${targetFrameId}). ${buildFrameDiagnostics(
        frameContextManager
      )}`,
      404
    );
  }

  if (!executionContextId && debug) {
    console.warn(
      `[resolveXPathWithCDP] Missing executionContextId for frame ${normalizedFrameIndex} (${targetFrameId}), continuing`
    );
  }

  await session.send("DOM.enable").catch(() => {});
  await session.send("Runtime.enable").catch(() => {});

  let evalResponse: {
    result: { objectId?: string | null };
    exceptionDetails?: unknown;
  };
  try {
    evalResponse = await session.send<{
      result: { objectId?: string | null };
      exceptionDetails?: unknown;
    }>("Runtime.evaluate", {
      expression: buildXPathEvaluationExpression(xpath),
      contextId: executionContextId,
      includeCommandLineAPI: false,
      returnByValue: false,
      awaitPromise: false,
    });
  } catch (error) {
    throw new HyperagentError(
      `Failed to evaluate XPath in frame ${normalizedFrameIndex}: ${formatXPathCDPDiagnostic(
        error
      )}`,
      500
    );
  }

  const objectId = evalResponse.result.objectId || undefined;
  if (!objectId) {
    throw new HyperagentError(
      `Failed to resolve XPath to objectId in frame ${normalizedFrameIndex}`,
      404
    );
  }

  let describeNode: { node?: { backendNodeId?: number } };
  try {
    describeNode = await session.send<{
      node?: { backendNodeId?: number };
    }>("DOM.describeNode", { objectId });
  } catch (error) {
    throw new HyperagentError(
      `Failed to describe resolved XPath node in frame ${normalizedFrameIndex}: ${formatXPathCDPDiagnostic(
        error
      )}`,
      500
    );
  }
  const backendNodeId = describeNode.node?.backendNodeId;
  if (typeof backendNodeId !== "number") {
    throw new HyperagentError(
      `DOM.describeNode did not return backendNodeId for frame ${normalizedFrameIndex}`,
      404
    );
  }

  return {
    backendNodeId,
    frameId: targetFrameId,
    objectId,
  };
}

function normalizeXPathInput(xpath: unknown): string {
  if (typeof xpath !== "string") {
    throw new HyperagentError("XPath must be a non-empty string", 400);
  }
  const normalized = xpath.trim();
  if (normalized.length === 0) {
    throw new HyperagentError("XPath must be a non-empty string", 400);
  }
  return normalized;
}

function normalizeFrameIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  return Math.floor(value);
}

async function safeWaitForExecutionContext(
  frameContextManager: FrameContextManager,
  targetFrameId: string
): Promise<number | undefined> {
  try {
    return await frameContextManager.waitForExecutionContext(targetFrameId);
  } catch (error) {
    throw new HyperagentError(
      `Failed while waiting for execution context (${targetFrameId}): ${formatXPathCDPDiagnostic(
        error
      )}`,
      500
    );
  }
}

function resolveTargetFrameId(
  frameIndex: number,
  frameContextManager?: FrameContextManager
): string | undefined {
  if (!frameContextManager) {
    return frameIndex === 0 ? "root" : undefined;
  }

  const directMatch = safeGetFrameByIndex(frameContextManager, frameIndex)?.frameId;
  if (directMatch) {
    return directMatch;
  }

  if (frameIndex === 0) {
    const rootFrame = safeGetAllFrames(frameContextManager)
      .find((frame) => frame.parentFrameId === null);
    return rootFrame?.frameId ?? "root";
  }

  return undefined;
}

function buildFrameDiagnostics(frameContextManager?: FrameContextManager): string {
  if (!frameContextManager) {
    return "FrameContextManager unavailable.";
  }
  const mappedIndices = safeGetAllFrames(frameContextManager)
    .map((frame) => ({
      frameId: frame.frameId,
      frameIndex: safeGetFrameIndex(frameContextManager, frame.frameId),
    }))
    .filter(
      (entry): entry is { frameId: string; frameIndex: number } =>
        typeof entry.frameIndex === "number"
    )
    .sort((a, b) => a.frameIndex - b.frameIndex)
    .map((entry) => `${entry.frameIndex}:${entry.frameId}`);

  return mappedIndices.length > 0
    ? `Available frames => ${mappedIndices.join(", ")}`
    : "No frame indices currently tracked.";
}

function safeGetAllFrames(
  frameContextManager: FrameContextManager
): Array<{ frameId: string; parentFrameId: string | null }> {
  try {
    return frameContextManager.frameGraph.getAllFrames();
  } catch {
    return [];
  }
}

function safeGetFrameByIndex(
  frameContextManager: FrameContextManager,
  frameIndex: number
): { frameId: string } | undefined {
  try {
    return frameContextManager.getFrameByIndex(frameIndex) ?? undefined;
  } catch {
    return undefined;
  }
}

function safeGetFrameIndex(
  frameContextManager: FrameContextManager,
  frameId: string
): number | undefined {
  try {
    return frameContextManager.getFrameIndex(frameId);
  } catch {
    return undefined;
  }
}

function buildXPathEvaluationExpression(xpath: string): string {
  const escaped = JSON.stringify(xpath);
  return `(function() {
    try {
      const result = document.evaluate(${escaped}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return result.singleNodeValue || null;
    } catch (error) {
      return null;
    }
  })();`;
}
