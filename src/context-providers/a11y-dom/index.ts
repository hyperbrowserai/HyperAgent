/**
 * Accessibility Tree DOM Provider
 * Main entry point for extracting and formatting accessibility trees
 */

import type { Protocol } from "devtools-protocol";
import type { Page } from "playwright-core";
import fs from "fs";
import path from "path";
import {
  A11yDOMState,
  AXNode,
  AccessibilityNode,
  BackendIdMaps,
  TreeResult,
  FrameDebugInfo,
  EncodedId,
  IframeInfo,
  DOMRect,
  FrameChunkEvent,
} from "./types";
import { buildBackendIdMaps } from "./build-maps";
import { buildHierarchicalTree } from "./build-tree";
import {
  injectScrollableDetection,
  findScrollableElementIds,
} from "./scrollable-detection";
import { injectBoundingBoxScriptSession } from "./bounding-box-batch";
import { hasInteractiveElements, createDOMFallbackNodes } from "./utils";
import { renderA11yOverlay } from "./visual-overlay";
import { getCDPClient, getOrCreateFrameContextManager } from "@/cdp";
import type { CDPClient, CDPSession } from "@/cdp";
import { domSnapshotCache } from "./dom-cache";
import { PerformanceTracker } from "./performance";
import { getDebugOptions } from "@/debug/options";

const DEFAULT_CONTEXT_COLLECTION_TIMEOUT_MS = 500;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function collectExecutionContexts(
  session: CDPSession,
  options: {
    frameIds?: Set<string>;
    timeoutMs?: number;
    debug?: boolean;
  } = {}
): Promise<Map<string, number>> {
  const {
    frameIds,
    timeoutMs = DEFAULT_CONTEXT_COLLECTION_TIMEOUT_MS,
    debug,
  } = options;

  if (frameIds && frameIds.size === 0) {
    return new Map();
  }

  const targetFrames = frameIds ? new Set(frameIds) : undefined;
  const contexts = new Map<string, number>();

  let finishWait: (() => void) | undefined;
  let finished = false;
  const waitPromise = targetFrames
    ? new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (finished) return;
          finished = true;
          resolve();
        }, timeoutMs);
        finishWait = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          resolve();
        };
      })
    : delay(timeoutMs);

  const handler = (
    event: Protocol.Runtime.ExecutionContextCreatedEvent
  ): void => {
    const auxData = event.context.auxData as
      | { frameId?: string; type?: string }
      | undefined;
    const frameId = auxData?.frameId;
    if (!frameId) return;
    if (targetFrames && !targetFrames.has(frameId)) return;
    const contextType = auxData?.type;
    if (contextType && contextType !== "default") return;
    if (contexts.has(frameId)) return;

    contexts.set(frameId, event.context.id);
    if (debug) {
      console.log(
        `[Runtime] Collected executionContextId ${event.context.id} for frame ${frameId}`
      );
    }

    if (targetFrames) {
      targetFrames.delete(frameId);
      if (targetFrames.size === 0) {
        finishWait?.();
      }
    }
  };

  session.on("Runtime.executionContextCreated", handler);
  try {
    await session.send("Runtime.enable").catch((error) => {
      if (debug) {
        console.warn(
          "[A11y] Failed to enable Runtime domain for context collection. " +
            "Execution contexts may be missing for iframe elements.",
          error
        );
      }
    });
    await waitPromise;
  } finally {
    session.off?.("Runtime.executionContextCreated", handler);
  }

  return contexts;
}

async function annotateFrameSessions(options: {
  session: CDPSession;
  frameMap?: Map<number, IframeInfo>;
  frameIndices?: number[];
  debug?: boolean;
}): Promise<void> {
  const { session, frameMap, frameIndices, debug } = options;
  if (!frameMap || frameMap.size === 0) {
    return;
  }

  const indices =
    frameIndices ?? Array.from(frameMap.entries()).map(([idx]) => idx);

  if (indices.length === 0) {
    return;
  }

  const frameIds = new Set<string>();
  for (const index of indices) {
    const info = frameMap.get(index);
    if (!info) continue;
    if (!info.frameId && info.cdpFrameId) {
      info.frameId = info.cdpFrameId;
    }
    const candidate = info.frameId ?? info.cdpFrameId;
    if (candidate) {
      frameIds.add(candidate);
    }
  }

  let contexts: Map<string, number> | undefined;
  if (frameIds.size > 0) {
    contexts = await collectExecutionContexts(session, {
      frameIds,
      debug,
    });
  }

  for (const index of indices) {
    const info = frameMap.get(index);
    if (!info) continue;
    info.cdpSessionId = session.id ?? info.cdpSessionId;
    if (!info.frameId && info.cdpFrameId) {
      info.frameId = info.cdpFrameId;
    }
    const frameId = info.frameId ?? info.cdpFrameId;
    if (frameId && contexts?.has(frameId)) {
      info.executionContextId = contexts.get(frameId);
    }
  }
}

interface SyncFrameContextOptions {
  manager: ReturnType<typeof getOrCreateFrameContextManager>;
  frameMap?: Map<number, IframeInfo>;
  rootSession: CDPSession;
  debug?: boolean;
}

/**
 * Sync FrameContextManager with frameMap from DOM traversal
 *
 * TWO-WAY SYNCHRONIZATION:
 * ========================
 *
 * SAME-ORIGIN IFRAMES:
 * -------------------
 * - DOM.getDocument (buildBackendIdMaps) discovers same-origin iframes via contentDocument
 * - contentDocument.frameId is typically UNDEFINED for same-origin iframes
 * - buildBackendIdMaps assigns frameIndex based on DFS traversal order (AUTHORITATIVE)
 * - buildBackendIdMaps stores iframeBackendNodeId (the <iframe> element's backendNodeId)
 *
 * - FrameContextManager tracks frames via Page.frameAttached CDP events
 * - FrameContextManager has frameId from CDP events
 * - FrameContextManager calls populateFrameOwner to get backendNodeId of <iframe> element
 *
 * - syncFrameContextManager matches by backendNodeId (primary key)
 * - Copies frameId from FrameContextManager → frameMap
 * - Copies executionContextId from FrameContextManager → frameMap
 * - Overwrites frameIndex in FrameContextManager with DOM traversal order
 *
 * OOPIF (Cross-Origin):
 * --------------------
 * - DOM.getDocument does NOT include OOPIF (pierce:true stops at origin boundaries)
 * - FrameContextManager discovers OOPIF via captureOOPIFs (separate CDP sessions)
 * - OOPIF always has frameId (they're separate CDP targets)
 * - OOPIF gets frameIndex when discovered or later added to frameMap
 * - No DOM traversal involvement for OOPIF
 */
async function syncFrameContextManager({
  manager,
  frameMap,
  rootSession,
  debug,
}: SyncFrameContextOptions): Promise<void> {
  manager.setDebug(debug);

  const { frameTree } =
    await rootSession.send<Protocol.Page.GetFrameTreeResponse>(
      "Page.getFrameTree"
    );
  const rootFrame = frameTree?.frame;

  if (!rootFrame) {
    if (debug) {
      console.warn(
        "[FrameContext] No root frame returned from Page.getFrameTree"
      );
    }
    return;
  }

  const frameIdByIndex = new Map<number, string>();
  frameIdByIndex.set(0, rootFrame.id);

  manager.upsertFrame({
    frameId: rootFrame.id,
    parentFrameId: rootFrame.parentId ?? null,
    loaderId: rootFrame.loaderId,
    name: rootFrame.name,
    url: rootFrame.url,
  });
  manager.assignFrameIndex(rootFrame.id, 0);
  manager.setFrameSession(rootFrame.id, rootSession);

  if (debug) {
    console.log(
      `[FrameContext] Registered root frame ${rootFrame.id} (url=${rootFrame.url})`
    );
  }

  if (!frameMap || frameMap.size === 0) {
    return;
  }

  const entries = Array.from(frameMap.entries()).sort(
    ([a], [b]) => Number(a) - Number(b)
  );

  await Promise.all(
    entries.map(async ([frameIndex, info]) => {
      // Try to get frameId from DOM response (usually undefined for same-origin iframes)
      let frameId = info.frameId ?? info.cdpFrameId;

      // Primary matching strategy: use backendNodeId to find frameId from FrameContextManager
      // FrameContextManager has frameId from CDP events (Page.frameAttached, etc.)
      if (!frameId && typeof info.iframeBackendNodeId === "number") {
        const matched = manager.getFrameByBackendNodeId(
          info.iframeBackendNodeId
        );
        if (matched) {
          frameId = matched.frameId;
          if (debug) {
            console.log(
              `[FrameContext] Matched same-origin frame ${frameIndex} via backendNodeId ${info.iframeBackendNodeId} -> frameId ${frameId}`
            );
          }
        }
      }

      if (!frameId) {
        if (debug) {
          console.warn(
            `[FrameContext] Frame ${frameIndex} could not be matched (backendNodeId=${info.iframeBackendNodeId}). Likely not ready or detached.`
          );
        }
        return;
      }

      frameIdByIndex.set(frameIndex, frameId);

      const parentIndex = info.parentFrameIndex;
      const parentFrameId =
        parentIndex === null
          ? null
          : (frameIdByIndex.get(parentIndex ?? 0) ?? frameIdByIndex.get(0)!);

      manager.upsertFrame({
        frameId,
        parentFrameId,
        url: info.src,
        name: info.name,
        backendNodeId: info.iframeBackendNodeId,
        executionContextId: info.executionContextId,
      });
      manager.assignFrameIndex(frameId, frameIndex);

      let session = manager.getFrameSession(frameId);
      if (!session) {
        session = rootSession;
        if (debug) {
          console.log(
            `[FrameContext] Reusing root session for frame ${frameIndex} (${frameId})`
          );
        }
        manager.setFrameSession(frameId, session);
      } else if (debug) {
        console.log(
          `[FrameContext] Frame ${frameIndex} (${frameId}) already has session ${session.id ?? "unknown"}`
        );
      }
    })
  );
}

async function hydrateFrameContextFromSnapshot(
  page: Page,
  snapshot: A11yDOMState,
  debug: boolean
): Promise<void> {
  if (!snapshot.frameMap || snapshot.frameMap.size === 0) {
    return;
  }
  try {
    const cdpClient = await getCDPClient(page);
    const manager = getOrCreateFrameContextManager(cdpClient);
    manager.setDebug(debug);
    await manager.ensureInitialized().catch(() => {});
    await syncFrameContextManager({
      manager,
      frameMap: snapshot.frameMap,
      rootSession: cdpClient.rootSession,
      debug,
    });
  } catch (error) {
    if (debug) {
      console.warn(
        "[FrameContext] Failed to hydrate frame manager from cache:",
        error
      );
    }
  }
}

/**
 * Build frame hierarchy paths for all frames
 * Handles both same-origin iframes and OOPIFs
 * Must be called after all frames are discovered (after fetchIframeAXTrees)
 */
function buildFramePaths(
  frameMap: Map<number, IframeInfo>,
  debug: boolean
): void {
  for (const [frameIndex, frameInfo] of frameMap) {
    const pathSegments: string[] = [];
    let currentIdx: number | null = frameIndex;
    const visited = new Set<number>();

    // Walk up parent chain using frameMap
    while (
      currentIdx !== null &&
      currentIdx !== 0 &&
      !visited.has(currentIdx)
    ) {
      visited.add(currentIdx);
      pathSegments.unshift(`Frame ${currentIdx}`);

      const info = frameMap.get(currentIdx);
      if (!info) {
        // Shouldn't happen if frameMap is properly constructed
        if (debug) {
          console.warn(
            `[A11y] Frame ${frameIndex}: parent frame ${currentIdx} not found in frameMap`
          );
        }
        break;
      }

      currentIdx = info.parentFrameIndex;
    }

    // Build final path based on where we ended up
    if (currentIdx === null) {
      // Root frame (no parent)
      frameInfo.framePath = pathSegments;
    } else if (currentIdx === 0) {
      // Parent is main frame
      frameInfo.framePath = ["Main", ...pathSegments];
    } else {
      // Circular reference detected
      if (debug) {
        console.warn(
          `[A11y] Frame ${frameIndex}: circular reference detected in parent chain`
        );
      }
      frameInfo.framePath = pathSegments;
    }

    if (debug) {
      console.log(
        `[A11y] Built path for frame ${frameIndex}: ${frameInfo.framePath.join(" → ")}`
      );
    }
  }
}

/**
 * Fetch accessibility trees for all iframes in the page
 * @param client CDP session
 * @param maps Backend ID maps containing frame metadata
 * @param debug Whether to collect debug information
 * @param enableVisualMode Whether visual mode is enabled (affects script injection)
 * @returns Tagged nodes and optional debug info
 */
async function fetchIframeAXTrees(
  client: CDPSession,
  maps: BackendIdMaps,
  debug: boolean,
  enableVisualMode: boolean,
  cdpClient: CDPClient,
  frameContextManager: ReturnType<typeof getOrCreateFrameContextManager>
): Promise<{
  nodes: Array<AXNode & { _frameIndex: number }>;
  debugInfo: Array<{
    frameIndex: number;
    frameUrl: string;
    totalNodes: number;
    rawNodes: AXNode[];
  }>;
}> {
  const allNodes: Array<AXNode & { _frameIndex: number }> = [];
  const frameDebugInfo: Array<{
    frameIndex: number;
    frameUrl: string;
    totalNodes: number;
    rawNodes: AXNode[];
  }> = [];

  const frameEntries = Array.from(maps.frameMap?.entries() ?? []);
  if (frameEntries.length === 0) {
    return { nodes: allNodes, debugInfo: frameDebugInfo };
  }

  const rootSession = cdpClient.rootSession;
  const processedCrossOriginFrames = new Set<string>();
  const sameOriginFrames: Array<[number, IframeInfo]> = [];

  for (const [frameIndex, frameInfo] of frameEntries) {
    const frameId = frameInfo.frameId ?? frameInfo.cdpFrameId;
    const session = frameId
      ? frameContextManager.getFrameSession(frameId)
      : undefined;
    const isCrossOrigin = frameId && session && session !== rootSession;

    if (isCrossOrigin && frameId && session) {
      if (processedCrossOriginFrames.has(frameId)) {
        continue;
      }
      await collectCrossOriginFrameData({
        frameIndex,
        frameInfo,
        session,
        maps,
        allNodes,
        frameDebugInfo,
        debug,
        enableVisualMode,
        frameContextManager,
      });
      processedCrossOriginFrames.add(frameId);
    } else {
      sameOriginFrames.push([frameIndex, frameInfo]);
    }
  }

  // Process same-origin iframes in parallel for better performance
  const sameOriginPromises = sameOriginFrames.map(
    async ([frameIndex, frameInfo]) => {
      const { contentDocumentBackendNodeId, src } = frameInfo;
      if (!contentDocumentBackendNodeId) {
        return null;
      }

      try {
        if (debug) {
          console.log(
            `[A11y] Processing same-origin frame ${frameIndex} from DOM traversal`
          );
        }

        const result = (await client.send("Accessibility.getPartialAXTree", {
          backendNodeId: contentDocumentBackendNodeId,
          fetchRelatives: true,
        })) as { nodes: AXNode[] };

        let iframeNodes = result.nodes;

        if (!hasInteractiveElements(iframeNodes)) {
          const domFallbackNodes = createDOMFallbackNodes(
            frameIndex,
            maps.tagNameMap,
            maps.frameMap || new Map(),
            maps.accessibleNameMap
          );

          if (domFallbackNodes.length > 0) {
            iframeNodes = domFallbackNodes;
          }
        }

        const taggedNodes = iframeNodes.map((n) => ({
          ...n,
          _frameIndex: frameIndex,
        }));

        return {
          frameIndex,
          nodes: taggedNodes,
          debugInfo: debug
            ? {
                frameIndex,
                frameUrl: src || "unknown",
                totalNodes: iframeNodes.length,
                rawNodes: iframeNodes,
              }
            : null,
        };
      } catch (error) {
        console.warn(
          `[A11y] Failed to fetch AX tree for frame ${frameIndex} (contentDocBackendNodeId=${contentDocumentBackendNodeId}):`,
          (error as Error).message || error
        );
        return null;
      }
    }
  );

  // Wait for all same-origin iframe processing to complete in parallel
  const sameOriginResults = await Promise.all(sameOriginPromises);

  // Merge results into allNodes and frameDebugInfo
  for (const result of sameOriginResults) {
    if (result) {
      allNodes.push(...result.nodes);
      if (result.debugInfo) {
        frameDebugInfo.push(result.debugInfo);
      }
    }
  }

  // Process OOPIF frames discovered by FrameContextManager in parallel
  const oopifFrames = frameContextManager.getOOPIFs();
  if (debug && oopifFrames.length > 0) {
    console.log(
      `[A11y] Processing ${oopifFrames.length} OOPIF frames from FrameContextManager (parallel)`
    );
  }

  const oopifPromises = oopifFrames.map(async (oopifFrame) => {
    const { frameId, url } = oopifFrame;
    const frameIndex = frameContextManager.getFrameIndex?.(frameId);
    const session = frameContextManager.getFrameSession(frameId);

    if (frameIndex === undefined || !session) {
      if (debug) {
        console.warn(
          `[A11y] OOPIF frame ${frameId} missing frameIndex or session, skipping`
        );
      }
      return null;
    }

    // Skip if already processed (shouldn't happen, but be safe)
    if (processedCrossOriginFrames.has(frameId)) {
      return null;
    }

    if (debug) {
      console.log(`[A11y] Processing OOPIF frame ${frameIndex} (${url})`);
    }

    try {
      const frameInfo: IframeInfo = {
        frameIndex,
        frameId,
        cdpFrameId: frameId,
        src: url,
        xpath: `//iframe[@frame-index="${frameIndex}"]`,
        parentFrameIndex: oopifFrame.parentFrameId
          ? (frameContextManager.getFrameIndex(oopifFrame.parentFrameId) ?? 0)
          : 0,
        siblingPosition: 0,
      };

      // Collect data for this OOPIF independently
      const oopifNodes: Array<AXNode & { _frameIndex: number }> = [];
      const oopifDebugInfo: Array<{
        frameIndex: number;
        frameUrl: string;
        totalNodes: number;
        rawNodes: AXNode[];
      }> = [];

      // Create isolated maps for this OOPIF to avoid race conditions
      const oopifMaps: BackendIdMaps = {
        tagNameMap: {},
        xpathMap: {},
        accessibleNameMap: {},
        backendNodeMap: {},
        frameMap: new Map(),
      };

      await collectCrossOriginFrameData({
        frameIndex,
        frameInfo,
        session,
        maps: oopifMaps,
        allNodes: oopifNodes,
        frameDebugInfo: oopifDebugInfo,
        debug,
        enableVisualMode,
        frameContextManager,
      });

      processedCrossOriginFrames.add(frameId);

      return {
        nodes: oopifNodes,
        maps: oopifMaps,
        debugInfo: oopifDebugInfo,
      };
    } catch (error) {
      console.warn(
        `[A11y] Failed to process OOPIF frame ${frameIndex} (${url}):`,
        (error as Error).message || error
      );
      return null;
    }
  });

  // Wait for all OOPIFs to complete in parallel
  const oopifResults = await Promise.all(oopifPromises);

  // Merge all OOPIF results into shared maps and allNodes
  for (const result of oopifResults) {
    if (result) {
      // Merge nodes
      allNodes.push(...result.nodes);

      // Merge maps
      Object.assign(maps.tagNameMap, result.maps.tagNameMap);
      Object.assign(maps.xpathMap, result.maps.xpathMap);
      Object.assign(maps.accessibleNameMap, result.maps.accessibleNameMap);
      Object.assign(maps.backendNodeMap, result.maps.backendNodeMap);

      // Merge frame maps
      if (result.maps.frameMap) {
        for (const [idx, info] of result.maps.frameMap.entries()) {
          if (!maps.frameMap?.has(idx)) {
            maps.frameMap?.set(idx, info);
          }
        }
      }

      // Merge debug info
      if (debug) {
        frameDebugInfo.push(...result.debugInfo);
      }
    }
  }

  return { nodes: allNodes, debugInfo: frameDebugInfo };
}

interface CrossOriginFrameParams {
  frameIndex: number;
  frameInfo: IframeInfo;
  session: CDPSession;
  maps: BackendIdMaps;
  allNodes: Array<AXNode & { _frameIndex: number }>;
  frameDebugInfo: Array<{
    frameIndex: number;
    frameUrl: string;
    totalNodes: number;
    rawNodes: AXNode[];
  }>;
  debug: boolean;
  enableVisualMode: boolean;
  frameContextManager: ReturnType<typeof getOrCreateFrameContextManager>;
}

async function collectCrossOriginFrameData({
  frameIndex,
  frameInfo,
  session,
  maps,
  allNodes,
  frameDebugInfo,
  debug,
  enableVisualMode,
  frameContextManager,
}: CrossOriginFrameParams): Promise<void> {
  const frameId = frameInfo.frameId ?? frameInfo.cdpFrameId;
  if (!frameId) {
    if (debug) {
      console.warn(
        `[A11y] Cross-origin frame ${frameIndex} missing frameId/cdpFrameId`
      );
    }
    return;
  }

  await Promise.all([
    session.send("DOM.enable").catch(() => {}),
    session.send("Accessibility.enable").catch(() => {}),
    session.send("Page.enable").catch(() => {}),
  ]);

  if (enableVisualMode) {
    await injectBoundingBoxScriptSession(session);
  }

  // Use pierce:false for OOPIF to prevent capturing transient/loading nested iframes
  // Any legitimate nested OOPIFs will be discovered via their own CDP sessions
  const subMaps = await buildBackendIdMaps(session, frameIndex, debug, false);

  Object.assign(maps.tagNameMap, subMaps.tagNameMap);
  Object.assign(maps.xpathMap, subMaps.xpathMap);
  Object.assign(maps.accessibleNameMap, subMaps.accessibleNameMap);
  Object.assign(maps.backendNodeMap, subMaps.backendNodeMap);
  maps.frameMap = maps.frameMap ?? new Map();

  const executionContextId =
    frameContextManager.getExecutionContextId(frameId) ??
    (await frameContextManager
      .waitForExecutionContext(frameId)
      .catch(() => undefined)) ??
    frameInfo.executionContextId;

  maps.frameMap.set(frameIndex, {
    ...frameInfo,
    frameIndex,
    frameId,
    cdpFrameId: frameId,
    cdpSessionId: session.id ?? frameInfo.cdpSessionId,
    executionContextId,
  });

  if (subMaps.frameMap?.size) {
    for (const [nestedIdx, nestedInfo] of subMaps.frameMap.entries()) {
      if (!maps.frameMap.has(nestedIdx)) {
        maps.frameMap.set(nestedIdx, nestedInfo);
      }
    }
  }

  const result = (await session.send("Accessibility.getFullAXTree")) as {
    nodes: AXNode[];
  };
  let nodes = result.nodes;

  if (!hasInteractiveElements(nodes)) {
    if (debug) {
      console.log(
        `[A11y] OOPIF frame ${frameIndex} has no interactive elements, falling back to DOM`
      );
    }
    const domFallbackNodes = createDOMFallbackNodes(
      frameIndex,
      maps.tagNameMap,
      maps.frameMap || new Map(),
      maps.accessibleNameMap
    );
    if (domFallbackNodes.length > 0) {
      nodes = domFallbackNodes;
    }
  }

  const taggedNodes = nodes.map((n) => ({
    ...n,
    _frameIndex: frameIndex,
  }));
  allNodes.push(...taggedNodes);

  if (debug) {
    frameDebugInfo.push({
      frameIndex,
      frameUrl: frameInfo.src || "unknown",
      totalNodes: nodes.length,
      rawNodes: nodes,
    });
  }
}

/**
 * Merge multiple tree results into a single combined state
 * @param treeResults Array of tree results from different frames
 * @returns Combined elements map, xpath map, and dom state text
 */
function mergeTreeResults(treeResults: TreeResult[]): {
  elements: Map<EncodedId, AccessibilityNode>;
  xpathMap: Record<EncodedId, string>;
  domState: string;
} {
  const allElements = new Map<EncodedId, AccessibilityNode>();
  const allXpaths: Record<EncodedId, string> = {};

  for (const result of treeResults) {
    for (const [id, element] of result.idToElement) {
      allElements.set(id, element);
    }
    Object.assign(allXpaths, result.xpathMap);
  }

  const combinedDomState = treeResults.map((r) => r.simplified).join("\n\n");

  return {
    elements: allElements,
    xpathMap: allXpaths,
    domState: combinedDomState,
  };
}

/**
 * Process raw frame debug info and add computed fields from tree results
 * @param frameDebugInfo Raw debug info collected during fetching
 * @param treeResults Tree results to correlate with debug info
 * @returns Processed debug info with computed fields
 */
function processFrameDebugInfo(
  frameDebugInfo: Array<{
    frameIndex: number;
    frameUrl: string;
    totalNodes: number;
    rawNodes: AXNode[];
  }>,
  treeResults: TreeResult[]
): FrameDebugInfo[] {
  return frameDebugInfo.map((debugFrame) => {
    // Find corresponding tree result
    const treeResult = treeResults.find((r) => {
      // Match by checking if any element in the tree has this frameIndex
      const sampleId = Array.from(r.idToElement.keys())[0];
      if (!sampleId) return false;
      const frameIdx = parseInt(sampleId.split("-")[0]);
      return frameIdx === debugFrame.frameIndex;
    });

    const treeElementCount = treeResult?.idToElement.size || 0;
    const interactiveCount = treeResult
      ? Array.from(treeResult.idToElement.values()).filter(
          (el: AccessibilityNode) =>
            ["button", "link", "textbox", "searchbox", "combobox"].includes(
              el.role
            )
        ).length
      : 0;

    // Include sample nodes for frames with few nodes to help diagnose issues
    const sampleNodes =
      debugFrame.totalNodes <= 15
        ? debugFrame.rawNodes.slice(0, 15).map((node) => ({
            role: node.role?.value,
            name: node.name?.value,
            nodeId: node.nodeId,
            ignored: node.ignored,
            childIds: node.childIds?.length,
          }))
        : undefined;

    return {
      frameIndex: debugFrame.frameIndex,
      frameUrl: debugFrame.frameUrl,
      totalNodes: debugFrame.totalNodes,
      treeElementCount,
      interactiveCount,
      sampleNodes,
    };
  });
}

/**
 * Get accessibility tree state from a page
 *
 * This function extracts accessibility trees from the main frame and all iframes:
 * 1. Detects all frames in the page
 * 2. For same-origin iframes: uses main CDP session with frameId parameter
 * 3. Merges all accessibility trees into a single state
 * 4. (Optional) Collects bounding boxes and renders visual overlay
 *
 * Note: Chrome's Accessibility API automatically includes same-origin iframe
 * content in the main frame's tree, so we primarily focus on the main frame.
 *
 * @param page - Playwright page
 * @param debug - Whether to collect debug information (frameDebugInfo)
 * @param enableVisualMode - Whether to collect bounding boxes and generate visual overlay
 * @returns A11yDOMState with elements map, text tree, and optional visual overlay
 */
interface GetA11yDomOptions {
  useCache?: boolean;
  enableStreaming?: boolean;
  onFrameChunk?: (chunk: FrameChunkEvent) => void;
}

export async function getA11yDOM(
  page: Page,
  debug = false,
  enableVisualMode = false,
  debugDir?: string,
  options?: GetA11yDomOptions
): Promise<A11yDOMState> {
  const debugOptions = getDebugOptions();
  const profileDom =
    debug ||
    (debugOptions.enabled && debugOptions.profileDomCapture) ||
    process.env.HYPERAGENT_PROFILE_DOM === "1" ||
    !!debugDir;
  const tracker = profileDom ? new PerformanceTracker("getA11yDOM") : null;
  const timeAsync = async <T>(
    name: string,
    fn: () => Promise<T>,
    metadata?: Record<string, unknown>
  ): Promise<T> => {
    if (!tracker) return await fn();
    tracker.startTimer(name, metadata);
    try {
      return await fn();
    } finally {
      tracker.stopTimer(name);
    }
  };

  const canUseCache = options?.useCache && !enableVisualMode;
  const onFrameChunk = options?.onFrameChunk;
  if (canUseCache) {
    const cached = domSnapshotCache.get(page);
    if (cached) {
      tracker?.mark("cacheHit");
      await hydrateFrameContextFromSnapshot(page, cached, debug);
      return cached;
    }
  }

  try {
    // Step 1: Inject scripts into the main frame
    await timeAsync("injectScrollableDetection", () =>
      injectScrollableDetection(page)
    );

    // Step 2: Create CDP session for main frame
    const cdpClient = await getCDPClient(page);
    const frameContextManager = getOrCreateFrameContextManager(cdpClient);
    frameContextManager.setDebug(debug);
    await frameContextManager.ensureInitialized().catch((error) => {
      if (debug) {
        console.warn(
          "[FrameContext] Failed to initialize frame manager:",
          error
        );
      }
    });
    const client = await timeAsync("acquireDomSession", () =>
      cdpClient.acquireSession("dom")
    );

    await timeAsync("Accessibility.enable", () =>
      client.send("Accessibility.enable")
    );

    if (enableVisualMode) {
      await timeAsync("injectBoundingBoxScript", () =>
        injectBoundingBoxScriptSession(client)
      );
    }

    // Step 3: Build backend ID maps (tag names and XPaths)
    // This traverses the full DOM including iframe content via DOM.getDocument with pierce: true
    const maps = await timeAsync("buildBackendIdMaps", () =>
      buildBackendIdMaps(client, 0, debug)
    );
    await annotateFrameSessions({
      session: client,
      frameMap: maps.frameMap,
      debug,
    });

    // Discover and attach OOPIF frames
    // TODO: In the future we might want to consider patching playwright so we can we access underlying CDP session ID for frame attach events for OOPIF
    // current problem is that the event only exposes sessionId, but this does not match any internal session ID playwright page.createCDPSession() creates.
    await frameContextManager.captureOOPIFs((maps.frameMap?.size ?? 0) + 1);

    // Step 4: Fetch accessibility trees for main frame and all iframes
    const allNodes: (AXNode & { _frameIndex: number })[] = [];

    // 4a. Fetch main frame accessibility tree
    const { nodes: mainNodes } = (await timeAsync(
      "fetchMainFrameAXTree",
      () =>
        client.send("Accessibility.getFullAXTree") as Promise<{
          nodes: AXNode[];
        }>
    )) as {
      nodes: AXNode[];
    };
    allNodes.push(...mainNodes.map((n) => ({ ...n, _frameIndex: 0 })));

    // 4b. Fetch accessibility trees for all iframes
    if (debug) {
      console.log("[A11y] Fetching iframe trees using CDP sessions");
    }

    const { nodes: iframeNodes, debugInfo: frameDebugInfo } = await timeAsync(
      "fetchIframeAXTrees",
      () =>
        fetchIframeAXTrees(
          client,
          maps,
          debug,
          enableVisualMode,
          cdpClient,
          frameContextManager
        )
    );
    allNodes.push(...iframeNodes);

    // 4c. Build frame hierarchy paths now that all frames are discovered
    buildFramePaths(maps.frameMap || new Map(), debug);
    await timeAsync("syncFrameContextManager", () =>
      syncFrameContextManager({
        manager: frameContextManager,
        frameMap: maps.frameMap,
        rootSession: cdpClient.rootSession,
        debug,
      })
    );

    // Step 4: Detect scrollable elements
    const scrollableIds = await timeAsync("findScrollableElements", () =>
      findScrollableElementIds(page, client)
    );

    // Step 5: Build hierarchical trees for each frame
    const frameGroups = new Map<number, AXNode[]>();
    for (const node of allNodes) {
      const frameIdx = node._frameIndex || 0;
      if (!frameGroups.has(frameIdx)) {
        frameGroups.set(frameIdx, []);
      }
      frameGroups.get(frameIdx)!.push(node);
    }

    const frameEntries = Array.from(frameGroups.entries());

    // Build trees for each frame (potentially in parallel)
    const treeResults = await Promise.all(
      frameEntries.map(async ([frameIdx, nodes], order) => {
        let boundingBoxTarget:
          | import("./bounding-box-batch").BoundingBoxTarget
          | undefined;

        if (enableVisualMode) {
          const frameInfo = maps.frameMap?.get(frameIdx);
          const frameId =
            frameInfo?.frameId ??
            frameInfo?.cdpFrameId ??
            frameContextManager.getFrameIdByIndex(frameIdx);
          if (frameId) {
            const frameSession =
              frameContextManager.getFrameSession(frameId) ??
              cdpClient.rootSession;
            const executionContextId =
              frameContextManager.getExecutionContextId(frameId) ??
              (await frameContextManager
                .waitForExecutionContext(frameId)
                .catch(() => undefined));
            boundingBoxTarget = {
              kind: "cdp",
              session: frameSession,
              executionContextId,
              frameId,
            };
          } else if (debug) {
            console.warn(
              `[A11y] Skipping bounding box capture for frame ${frameIdx} - missing frameId`
            );
          }
        }

        const treeResult = await timeAsync(
          `buildFrameTree:${frameIdx}`,
          () =>
            buildHierarchicalTree(
              nodes,
              maps,
              frameIdx,
              scrollableIds,
              debug,
              enableVisualMode,
              boundingBoxTarget,
              debugDir
            ),
          { nodeCount: nodes.length }
        );

        if (onFrameChunk) {
          const frameInfo = maps.frameMap?.get(frameIdx);
          onFrameChunk({
            frameIndex: frameIdx,
            framePath: frameInfo?.framePath,
            frameUrl:
              frameInfo?.src ?? (frameIdx === 0 ? page.url() : undefined),
            simplified: treeResult.simplified,
            totalNodes: nodes.length,
            order,
          });
        }

        return treeResult;
      })
    );

    // Step 6: Merge all trees into combined state
    const {
      elements: allElements,
      xpathMap: allXpaths,
      domState: combinedDomState,
    } = mergeTreeResults(treeResults);

    // Step 7: Process debug info - add computed fields from tree results (only if debug enabled)
    const processedDebugInfo = debug
      ? processFrameDebugInfo(frameDebugInfo, treeResults)
      : undefined;

    // Step 8: Generate visual overlay if enabled
    let visualOverlay: string | undefined;
    let boundingBoxMap: Map<EncodedId, DOMRect> | undefined;

    if (enableVisualMode) {
      // Collect all bounding boxes from tree results
      boundingBoxMap = new Map();
      for (const result of treeResults) {
        if (result.boundingBoxMap) {
          for (const [encodedId, rect] of result.boundingBoxMap) {
            boundingBoxMap.set(encodedId, rect);
          }
        }
      }

      // Render overlay if we have bounding boxes
      if (boundingBoxMap.size > 0) {
        // Get viewport dimensions (calculate from page if not set)
        let viewport = page.viewportSize();
        if (!viewport) {
          viewport = await page.evaluate(() => ({
            width: window.innerWidth,
            height: window.innerHeight,
          }));
        }

        // Filter to only include boxes that are within or overlap the viewport
        const visibleBoundingBoxMap = new Map<EncodedId, DOMRect>();
        let droppedByViewport = 0;
        for (const [encodedId, rect] of boundingBoxMap.entries()) {
          // Check if box overlaps viewport (accounting for partial visibility)
          const isVisible =
            rect.right > 0 &&
            rect.bottom > 0 &&
            rect.left < viewport.width &&
            rect.top < viewport.height;

          if (isVisible) {
            visibleBoundingBoxMap.set(encodedId, rect);
          } else {
            droppedByViewport += 1;
          }
        }

        if (console.debug) {
          console.debug(
            `[A11y Visual] Frame 0 overlay: kept ${visibleBoundingBoxMap.size}/${boundingBoxMap.size} boxes (dropped ${droppedByViewport} offscreen)`
          );
        }

        visualOverlay = await timeAsync("renderA11yOverlay", () =>
          renderA11yOverlay(visibleBoundingBoxMap, {
            width: viewport.width,
            height: viewport.height,
            showEncodedIds: true,
            colorScheme: "rainbow",
          })
        );

        if (debug) {
          console.log(
            `[A11y Visual] Rendered ${visibleBoundingBoxMap.size} elements (filtered from ${boundingBoxMap.size} total)`
          );
        }
      }
    }

    const snapshot: A11yDOMState = {
      elements: allElements,
      domState: combinedDomState,
      xpathMap: allXpaths,
      backendNodeMap: maps.backendNodeMap,
      frameMap: maps.frameMap,
      ...(debug && { frameDebugInfo: processedDebugInfo }),
      ...(enableVisualMode && { boundingBoxMap, visualOverlay }),
    };

    if (canUseCache) {
      domSnapshotCache.set(page, snapshot);
      tracker?.mark("cacheStore");
    }

    tracker?.finish();
    if (tracker && debugDir) {
      try {
        fs.mkdirSync(debugDir, { recursive: true });
        fs.writeFileSync(
          path.join(debugDir, "dom-capture-metrics.json"),
          tracker.toJSON()
        );
      } catch {
        // best effort
      }
    } else if (tracker && debug) {
      console.log(tracker.formatReport());
    }

    return snapshot;
  } catch (error) {
    console.error("Error extracting accessibility tree:", error);
    if (error instanceof Error) {
      console.error("Error details:", {
        message: error.message,
        stack: error.stack,
        name: error.name,
      });
    }

    // Fallback to empty state
    return {
      elements: new Map(),
      domState: "Error: Could not extract accessibility tree",
      xpathMap: {},
      backendNodeMap: {},
      frameMap: new Map(),
    };
  }
}

/**
 * Export all types and utilities
 */
export * from "./types";
export * from "./utils";
export * from "./build-maps";
export * from "./build-tree";
export * from "./scrollable-detection";
