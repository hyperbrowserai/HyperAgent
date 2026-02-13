import { CDPClient } from "@/cdp/types";
import { FrameContextManager } from "@/cdp/frame-context-manager";
import { HyperagentError } from "../error";

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

export async function resolveXPathWithCDP(
  params: ResolveXPathWithCDPParams
): Promise<ResolvedCDPFromXPath> {
  const { xpath, frameIndex = 0, cdpClient, frameContextManager, debug } =
    params;
  const normalizedFrameIndex = frameIndex ?? 0;

  // Use a DOM session without detaching the shared session; this keeps root session intact.
  const session = await cdpClient.acquireSession("dom");
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
    ? await frameContextManager.waitForExecutionContext(targetFrameId)
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
      `[resolveXPathWithCDP] Missing executionContextId for frame ${frameIndex} (${targetFrameId}), continuing`
    );
  }

  await session.send("DOM.enable").catch(() => {});
  await session.send("Runtime.enable").catch(() => {});

  const evalResponse = await session.send<{
    result: { objectId?: string | null };
    exceptionDetails?: unknown;
  }>("Runtime.evaluate", {
    expression: buildXPathEvaluationExpression(xpath),
    contextId: executionContextId,
    includeCommandLineAPI: false,
    returnByValue: false,
    awaitPromise: false,
  });

  const objectId = evalResponse.result.objectId || undefined;
  if (!objectId) {
    throw new HyperagentError(
      `Failed to resolve XPath to objectId in frame ${frameIndex}`,
      404
    );
  }

  const describeNode = await session.send<{
    node?: { backendNodeId?: number };
  }>("DOM.describeNode", { objectId });
  const backendNodeId = describeNode.node?.backendNodeId;
  if (typeof backendNodeId !== "number") {
    throw new HyperagentError(
      `DOM.describeNode did not return backendNodeId for frame ${frameIndex}`,
      404
    );
  }

  return {
    backendNodeId,
    frameId: targetFrameId,
    objectId,
  };
}

function resolveTargetFrameId(
  frameIndex: number,
  frameContextManager?: FrameContextManager
): string | undefined {
  if (!frameContextManager) {
    return frameIndex === 0 ? "root" : undefined;
  }

  const directMatch = frameContextManager.getFrameByIndex(frameIndex)?.frameId;
  if (directMatch) {
    return directMatch;
  }

  if (frameIndex === 0) {
    const rootFrame = frameContextManager
      .frameGraph
      .getAllFrames()
      .find((frame) => frame.parentFrameId === null);
    return rootFrame?.frameId ?? "root";
  }

  return undefined;
}

function buildFrameDiagnostics(frameContextManager?: FrameContextManager): string {
  if (!frameContextManager) {
    return "FrameContextManager unavailable.";
  }
  const mappedIndices = frameContextManager
    .frameGraph
    .getAllFrames()
    .map((frame) => ({
      frameId: frame.frameId,
      frameIndex: frameContextManager.getFrameIndex(frame.frameId),
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
