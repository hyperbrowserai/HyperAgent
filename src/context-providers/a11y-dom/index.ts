/**
 * Accessibility Tree DOM Provider
 * Main entry point for extracting and formatting accessibility trees
 */

import { Page, CDPSession } from "playwright-core";
import {
  A11yDOMState,
  AXNode,
  AccessibilityNode,
  BackendIdMaps,
  TreeResult,
  FrameDebugInfo,
  EncodedId,
} from "./types";
import { buildBackendIdMaps } from "./build-maps";
import { buildHierarchicalTree } from "./build-tree";
import {
  injectScrollableDetection,
  findScrollableElementIds,
} from "./scrollable-detection";
import {
  hasInteractiveElements,
  createDOMFallbackNodes,
} from "./utils";

/**
 * Fetch accessibility trees for all iframes in the page
 * @param client CDP session
 * @param maps Backend ID maps containing frame metadata
 * @param debug Whether to collect debug information
 * @returns Tagged nodes and optional debug info
 */
async function fetchIframeAXTrees(
  client: CDPSession,
  maps: BackendIdMaps,
  debug: boolean
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

  // Iterate through each iframe found in DOM traversal
  for (const [frameIndex, frameInfo] of maps.frameMap?.entries() ?? []) {
    const { contentDocumentBackendNodeId, src } = frameInfo;

    if (!contentDocumentBackendNodeId) {
      console.warn(
        `[A11y] Frame ${frameIndex} has no contentDocumentBackendNodeId, skipping`
      );
      continue;
    }

    try {
      // Fetch accessibility tree using the iframe's content document's backendNodeId
      const result = (await client.send("Accessibility.getPartialAXTree", {
        backendNodeId: contentDocumentBackendNodeId,
        fetchRelatives: true,
      })) as { nodes: AXNode[] };

      let iframeNodes = result.nodes;

      // Fallback to DOM when AX tree has no interactive elements
      if (!hasInteractiveElements(iframeNodes)) {
        console.log(
          `[A11y] Frame ${frameIndex} has no interactive elements in AX tree, falling back to DOM`
        );

        const domFallbackNodes = createDOMFallbackNodes(
          frameIndex,
          maps.tagNameMap,
          maps.frameMap || new Map()
        );

        if (domFallbackNodes.length > 0) {
          iframeNodes = domFallbackNodes;
        }
      }

      // Tag nodes with their frame index
      const taggedNodes = iframeNodes.map((n) => ({
        ...n,
        _frameIndex: frameIndex,
      }));

      allNodes.push(...taggedNodes);

      // Collect debug info (only if debug mode enabled)
      if (debug) {
        frameDebugInfo.push({
          frameIndex,
          frameUrl: src || "unknown",
          totalNodes: iframeNodes.length,
          rawNodes: iframeNodes,
        });
      }
    } catch (error) {
      console.warn(
        `[A11y] Failed to fetch AX tree for frame ${frameIndex} (contentDocBackendNodeId=${contentDocumentBackendNodeId}):`,
        (error as Error).message || error
      );
    }
  }

  return { nodes: allNodes, debugInfo: frameDebugInfo };
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
            [
              "button",
              "link",
              "textbox",
              "searchbox",
              "combobox",
            ].includes(el.role)
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
 *
 * Note: Chrome's Accessibility API automatically includes same-origin iframe
 * content in the main frame's tree, so we primarily focus on the main frame.
 *
 * @param page - Playwright page
 * @param debug - Whether to collect debug information (frameDebugInfo)
 * @returns A11yDOMState with elements map and text tree
 */
export async function getA11yDOM(
  page: Page,
  debug = false
): Promise<A11yDOMState> {
  try {
    // Step 1: Inject scrollable detection script into the main frame
    await injectScrollableDetection(page);

    // Step 2: Create CDP session for main frame
    const client = await page.context().newCDPSession(page);

    try {
      await client.send("Accessibility.enable");

      // Step 3: Build backend ID maps (tag names and XPaths)
      // This traverses the full DOM including iframe content via DOM.getDocument with pierce: true
      const maps = await buildBackendIdMaps(client, 0, debug);

      // Step 4: Fetch accessibility trees for main frame and all iframes
      const allNodes: (AXNode & { _frameIndex: number })[] = [];

      // 4a. Fetch main frame accessibility tree
      const { nodes: mainNodes } = (await client.send(
        "Accessibility.getFullAXTree"
      )) as {
        nodes: AXNode[];
      };
      allNodes.push(...mainNodes.map((n) => ({ ...n, _frameIndex: 0 })));

      // 4b. Fetch accessibility trees for all iframes
      const { nodes: iframeNodes, debugInfo: frameDebugInfo } =
        await fetchIframeAXTrees(client, maps, debug);
      allNodes.push(...iframeNodes);

      // Step 4: Detect scrollable elements
      const scrollableIds = await findScrollableElementIds(page, client);

      // Step 5: Build hierarchical trees for each frame
      const frameGroups = new Map<number, AXNode[]>();
      for (const node of allNodes) {
        const frameIdx = node._frameIndex || 0;
        if (!frameGroups.has(frameIdx)) {
          frameGroups.set(frameIdx, []);
        }
        frameGroups.get(frameIdx)!.push(node);
      }

      // Build trees for each frame
      const treeResults = await Promise.all(
        Array.from(frameGroups.entries()).map(async ([frameIdx, nodes]) => {
          const treeResult = await buildHierarchicalTree(
            nodes,
            maps,
            frameIdx,
            scrollableIds
          );

          return treeResult;
        })
      );

      // Step 6: Merge all trees into combined state
      const { elements: allElements, xpathMap: allXpaths, domState: combinedDomState } =
        mergeTreeResults(treeResults);

      // Step 7: Process debug info - add computed fields from tree results (only if debug enabled)
      const processedDebugInfo = debug
        ? processFrameDebugInfo(frameDebugInfo, treeResults)
        : undefined;

      return {
        elements: allElements,
        domState: combinedDomState,
        xpathMap: allXpaths,
        frameMap: maps.frameMap,
        ...(debug && { frameDebugInfo: processedDebugInfo }),
      };
    } finally {
      await client.detach();
    }
  } catch (error) {
    console.error("Error extracting accessibility tree:", error);

    // Fallback to empty state
    return {
      elements: new Map(),
      domState: "Error: Could not extract accessibility tree",
      xpathMap: {},
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
