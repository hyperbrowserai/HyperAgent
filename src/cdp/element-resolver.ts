import type { Protocol } from "devtools-protocol";
import type { Page } from "playwright-core";

import type { CDPClient, CDPSession } from "@/cdp/types";
import type { FrameContextManager } from "@/cdp/frame-context-manager";
import { getOrCreateFrameContextManager } from "@/cdp/frame-context-manager";
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
  frameContextManager?: FrameContextManager;
  debug?: boolean;
  strictFrameValidation?: boolean;
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
  const frameManager =
    ctx.frameContextManager ?? getOrCreateFrameContextManager(ctx.cdpClient);

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
    { frameIndex, frameInfo },
    frameManager,
    ctx.strictFrameValidation
  );

  let backendNodeId = ctx.backendNodeMap[encodedId];

  if (backendNodeId === undefined) {
    backendNodeId = await recoverBackendNodeId(
      encodedId,
      ctx,
      session,
      frameIndex,
      frameInfo,
      frameId,
      frameManager,
      ctx.strictFrameValidation
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
      frameInfo,
      frameId,
      frameManager,
      ctx.strictFrameValidation
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

  logDebug(
    ctx,
    `[ElementResolver] Resolved ${encodedId} via backendNodeId ${backendNodeId} (frameId=${frameId}, session=${session.id ?? "unknown"})`
  );

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

interface FrameSessionRequest {
  frameIndex: number;
  frameInfo?: IframeInfo;
}

async function resolveFrameSession(
  ctx: ElementResolveContext,
  { frameIndex, frameInfo }: FrameSessionRequest,
  frameManager: FrameContextManager,
  strict?: boolean
): Promise<{ session: CDPSession; frameId: string }> {
  const cache = getSessionCache(ctx.cdpClient);
  const frameId = resolveFrameId(frameManager, frameInfo, frameIndex, strict);

  if (cache.has(frameIndex)) {
    const cached = cache.get(frameIndex)!;
    logDebug(
      ctx,
      `[ElementResolver] Using cached session for frameIndex=${frameIndex} (frameId=${frameId})`
    );
    return { session: cached, frameId };
  }

  const managedSession = frameManager?.getFrameSession(frameId);
  if (managedSession) {
    cache.set(frameIndex, managedSession);
    logDebug(
      ctx,
      `[ElementResolver] Reusing manager session ${managedSession.id ?? "root"} for frameIndex=${frameIndex} (frameId=${frameId})`
    );
    return { session: managedSession, frameId };
  }
  throw new Error(
    `[CDP][ElementResolver] Session not registered for frameIndex=${frameIndex} (frameId=${frameId})`
  );
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
    const session = await ctx.cdpClient.acquireSession("dom");
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

function resolveFrameId(
  manager: FrameContextManager | undefined,
  frameInfo: IframeInfo | undefined,
  frameIndex: number,
  strict?: boolean
): string {
  const managerFrameId = manager?.getFrameIdByIndex(frameIndex);
  if (managerFrameId) {
    return managerFrameId;
  }
  if (strict) {
    throw new Error(
      `[CDP][ElementResolver] Frame index ${frameIndex} not tracked in FrameContextManager`
    );
  }
  return getFallbackFrameId(frameInfo, frameIndex);
}

function getFallbackFrameId(
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

function logDebug(ctx: ElementResolveContext, message: string): void {
  if (ctx.debug) {
    console.log(message);
  }
}

async function recoverBackendNodeId(
  encodedId: EncodedId,
  ctx: ElementResolveContext,
  session: CDPSession,
  frameIndex: number,
  frameInfo: IframeInfo | undefined,
  frameId: string,
  frameManager?: FrameContextManager,
  strict?: boolean
): Promise<number> {
  const xpath = ctx.xpathMap[encodedId];
  if (!xpath) {
    throw new Error(`XPath not found for encodedId ${encodedId}`);
  }

  let executionContextId =
    (frameManager?.getExecutionContextId(frameId) ??
      frameInfo?.executionContextId) ??
    undefined;

  if (!executionContextId && frameManager) {
    executionContextId = await frameManager
      .waitForExecutionContext(frameId)
      .catch(() => undefined);
  }

  logDebug(
    ctx,
    `[ElementResolver] Recovering backendNodeId for ${encodedId} via XPath (frameIndex=${frameIndex}, frameId=${frameId})`
  );

  // Validate execution context for iframe elements
  if (frameIndex !== 0 && !executionContextId) {
    if (strict) {
      throw new Error(
        `[CDP][ElementResolver] Execution context missing for frame ${frameIndex} (${frameId})`
      );
    }
    console.warn(
      `[CDP][ElementResolver] executionContextId missing for frame ${frameIndex} (${frameId}). ` +
        `XPath evaluation may fail or evaluate in wrong context. ` +
        `This can happen if execution context collection timed out. ` +
        `Consider increasing DEFAULT_CONTEXT_COLLECTION_TIMEOUT_MS in a11y-dom/index.ts`
    );
  }

  await ensureRuntimeEnabled(session);
  await ensureDomEnabled(session);

  const evalResponse =
    await session.send<Protocol.Runtime.EvaluateResponse>("Runtime.evaluate", {
      expression: buildXPathEvaluationExpression(xpath),
      contextId: executionContextId,
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
    const description =
      await session.send<Protocol.DOM.DescribeNodeResponse>(
        "DOM.describeNode",
        { objectId }
      );
    const backendNodeId = description.node?.backendNodeId;
    if (typeof backendNodeId !== "number") {
      throw new Error(
        `DOM.describeNode did not return backendNodeId for ${encodedId} (frame ${frameIndex})`
      );
    }

    ctx.backendNodeMap[encodedId] = backendNodeId;
    logDebug(
      ctx,
      `[ElementResolver] XPath recovery succeeded for ${encodedId} (backendNodeId=${backendNodeId})`
    );
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
  return await session.send<Protocol.DOM.ResolveNodeResponse>(
    "DOM.resolveNode",
    { backendNodeId }
  );
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
