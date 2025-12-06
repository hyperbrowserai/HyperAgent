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

  // Use a DOM session without detaching the shared session; this keeps root session intact.
  const session = await cdpClient.acquireSession("dom");
  let targetFrameId: string | undefined;

  if (frameContextManager) {
    const frameInfo = frameContextManager.getFrameByIndex(frameIndex ?? 0);
    targetFrameId = frameInfo?.frameId;
  }

  if (!targetFrameId) {
    throw new HyperagentError(
      `Unable to resolve frameId for frameIndex ${frameIndex}`,
      404
    );
  }

  const executionContextId = frameContextManager
    ? await frameContextManager.waitForExecutionContext(targetFrameId)
    : undefined;

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
