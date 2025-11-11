import type { Protocol } from "devtools-protocol";
import type { Page } from "playwright-core";

import type { CDPClient, CDPSession } from "@/cdp/types";
import type {
  EncodedId,
  IframeInfo,
} from "@/context-providers/a11y-dom/types";

export interface ElementResolveContext {
  page: Page;
  cdpClient: CDPClient;
  backendNodeMap: Record<EncodedId, number>;
  xpathMap: Record<EncodedId, string>;
  frameMap?: Map<number, IframeInfo>;
  resolvedElementsCache?: Map<EncodedId, ResolvedCDPElement>;
}

export interface ResolvedCDPElement {
  session: CDPSession;
  frameId: string;
  backendNodeId: number;
  objectId?: string;
}

const sessionCache = new WeakMap<CDPClient, Map<number, CDPSession>>();
const domEnabledSessions = new WeakSet<CDPSession>();
const runtimeEnabledSessions = new WeakSet<CDPSession>();

export async function resolveElement(
  encodedId: EncodedId,
  ctx: ElementResolveContext
): Promise<ResolvedCDPElement> {
  const frameIndex = parseFrameIndex(encodedId);
  const frameInfo = frameIndex === 0 ? undefined : ctx.frameMap?.get(frameIndex);

  if (frameIndex !== 0 && !frameInfo) {
    throw new Error(
      `Frame metadata not found for frameIndex ${frameIndex} (encodedId ${encodedId})`
    );
  }

  const cachedElement = ctx.resolvedElementsCache?.get(encodedId);
  if (
    cachedElement &&
    ctx.backendNodeMap[encodedId] === cachedElement.backendNodeId
  ) {
    return cachedElement;
  }

  const { session, frameId } = await resolveFrameSession(
    ctx,
    frameIndex,
    frameInfo
  );

  let backendNodeId = ctx.backendNodeMap[encodedId];

  if (backendNodeId === undefined) {
    backendNodeId = await recoverBackendNodeId(
      encodedId,
      ctx,
      session,
      frameIndex,
      frameInfo
    );
  }

  let resolveResponse: Protocol.DOM.ResolveNodeResponse;
  try {
    resolveResponse = await resolveNodeByBackendId(session, backendNodeId);
  } catch (error) {
    if (!isMissingNodeError(error)) {
      throw error;
    }
    backendNodeId = await recoverBackendNodeId(
      encodedId,
      ctx,
      session,
      frameIndex,
      frameInfo
    );
    resolveResponse = await resolveNodeByBackendId(session, backendNodeId);
  }

  ctx.backendNodeMap[encodedId] = backendNodeId;

  const resolved: ResolvedCDPElement = {
    session,
    frameId,
    backendNodeId,
    objectId: resolveResponse.object?.objectId,
  };

  if (!ctx.resolvedElementsCache) {
    ctx.resolvedElementsCache = new Map();
  }
  ctx.resolvedElementsCache.set(encodedId, resolved);

  return resolved;
}

function parseFrameIndex(encodedId: EncodedId): number {
  const [frameIndexStr] = encodedId.split("-");
  return Number.parseInt(frameIndexStr || "0", 10) || 0;
}

async function resolveFrameSession(
  ctx: ElementResolveContext,
  frameIndex: number,
  frameInfo?: IframeInfo
): Promise<{ session: CDPSession; frameId: string }> {
  const cache = getSessionCache(ctx.cdpClient);

  if (cache.has(frameIndex)) {
    const cached = cache.get(frameIndex)!;
    return { session: cached, frameId: getFrameId(frameInfo, frameIndex) };
  }

  const rootSession = await ensureRootSession(ctx);

  if (frameIndex === 0 || !frameInfo?.playwrightFrame) {
    cache.set(frameIndex, rootSession);
    return { session: rootSession, frameId: getFrameId(frameInfo, frameIndex) };
  }

  const session = await ctx.cdpClient.createSession({
    type: "frame",
    frame: frameInfo.playwrightFrame,
  });
  cache.set(frameIndex, session);
  return { session, frameId: getFrameId(frameInfo, frameIndex) };
}

async function ensureRootSession(
  ctx: ElementResolveContext
): Promise<CDPSession> {
  try {
    const session = ctx.cdpClient.rootSession;
    const cache = getSessionCache(ctx.cdpClient);
    if (!cache.has(0)) {
      cache.set(0, session);
    }
    return session;
  } catch {
    const session = await ctx.cdpClient.createSession({
      type: "page",
      page: ctx.page,
    });
    const cache = getSessionCache(ctx.cdpClient);
    cache.set(0, session);
    return session;
  }
}

function getSessionCache(client: CDPClient): Map<number, CDPSession> {
  let cache = sessionCache.get(client);
  if (!cache) {
    cache = new Map();
    sessionCache.set(client, cache);
  }
  return cache;
}

function getFrameId(
  frameInfo: IframeInfo | undefined,
  frameIndex: number
): string {
  if (frameInfo?.frameId) {
    return frameInfo.frameId;
  }
  if (frameInfo?.cdpFrameId) {
    return frameInfo.cdpFrameId;
  }
  return frameIndex === 0 ? "root" : `frame-${frameIndex}`;
}

async function recoverBackendNodeId(
  encodedId: EncodedId,
  ctx: ElementResolveContext,
  session: CDPSession,
  frameIndex: number,
  frameInfo?: IframeInfo
): Promise<number> {
  const xpath = ctx.xpathMap[encodedId];
  if (!xpath) {
    throw new Error(`XPath not found for encodedId ${encodedId}`);
  }

  await ensureRuntimeEnabled(session);
  await ensureDomEnabled(session);

  const evalResponse =
    await session.send<Protocol.Runtime.EvaluateResponse>("Runtime.evaluate", {
      expression: buildXPathEvaluationExpression(xpath),
      contextId: frameInfo?.executionContextId,
      includeCommandLineAPI: false,
      returnByValue: false,
      awaitPromise: false,
    });

  const objectId = evalResponse.result.objectId;
  if (!objectId) {
    throw new Error(
      `Failed to recover node for ${encodedId} (frame ${frameIndex}) via XPath`
    );
  }

  try {
    const { nodeId } = await session.send<Protocol.DOM.RequestNodeResponse>(
      "DOM.requestNode",
      { objectId }
    );
    if (typeof nodeId !== "number") {
      throw new Error(
        `DOM.requestNode did not return a nodeId for ${encodedId} (frame ${frameIndex})`
      );
    }

    const describeResponse =
      await session.send<Protocol.DOM.DescribeNodeResponse>("DOM.describeNode", {
        nodeId,
      });
    const backendNodeId = describeResponse.node?.backendNodeId;
    if (typeof backendNodeId !== "number") {
      throw new Error(
        `DOM.describeNode did not return backendNodeId for ${encodedId} (frame ${frameIndex})`
      );
    }

    ctx.backendNodeMap[encodedId] = backendNodeId;
    return backendNodeId;
  } finally {
    await session
      .send("Runtime.releaseObject", { objectId })
      .catch(() => {});
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

async function ensureDomEnabled(session: CDPSession): Promise<void> {
  if (domEnabledSessions.has(session)) {
    return;
  }
  await session.send("DOM.enable").catch(() => {});
  domEnabledSessions.add(session);
}

async function ensureRuntimeEnabled(session: CDPSession): Promise<void> {
  if (runtimeEnabledSessions.has(session)) {
    return;
  }
  await session.send("Runtime.enable").catch(() => {});
  runtimeEnabledSessions.add(session);
}

async function resolveNodeByBackendId(
  session: CDPSession,
  backendNodeId: number
): Promise<Protocol.DOM.ResolveNodeResponse> {
  return (await session.send<Protocol.DOM.ResolveNodeResponse>(
    "DOM.resolveNode",
    { backendNodeId }
  )) as Protocol.DOM.ResolveNodeResponse;
}

function isMissingNodeError(error: unknown): boolean {
  if (!(error instanceof Error) || !error.message) {
    return false;
  }
  return (
    error.message.includes("Could not find node with given id") ||
    error.message.includes("No node with given id")
  );
}
