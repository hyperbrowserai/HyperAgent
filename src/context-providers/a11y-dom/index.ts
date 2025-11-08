/**
 * Accessibility Tree DOM Provider
 * Main entry point for extracting and formatting accessibility trees
 */

import { Page, CDPSession, Frame } from "playwright-core";
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
} from "./types";
import { buildBackendIdMaps } from "./build-maps";
import { buildHierarchicalTree } from "./build-tree";
import {
  injectScrollableDetection,
  findScrollableElementIds,
} from "./scrollable-detection";
import { injectBoundingBoxScript } from "./bounding-box-batch";
import { hasInteractiveElements, createDOMFallbackNodes } from "./utils";
import { renderA11yOverlay } from "./visual-overlay";

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
 * Process a single OOPIF frame recursively, ensuring parents are processed first
 */
async function processOOPIFRecursive(
  frame: Frame,
  page: Page,
  maps: BackendIdMaps,
  allNodes: Array<AXNode & { _frameIndex: number }>,
  frameDebugInfo: Array<{
    frameIndex: number;
    frameUrl: string;
    totalNodes: number;
    rawNodes: AXNode[];
  }>,
  mergedMaps: {
    tagNameMap: Record<EncodedId, string>;
    xpathMap: Record<EncodedId, string>;
    accessibleNameMap: Record<EncodedId, string>;
  },
  nextFrameIndex: { value: number },
  processedOOPIFs: Set<Frame>,
  playwrightFrameToIndex: Map<Frame, number>,
  debug: boolean,
  enableVisualMode: boolean
): Promise<void> {
  // Skip if already processed
  if (processedOOPIFs.has(frame)) return;

  // Skip main frame
  if (frame === page.mainFrame()) {
    playwrightFrameToIndex.set(frame, 0);
    return;
  }

  // Try to create CDP session - if it fails, this is a same-origin iframe (skip)
  let oopifSession: CDPSession | null = null;
  try {
    oopifSession = await page.context().newCDPSession(frame);
  } catch {
    // Not an OOPIF, skip
    return;
  }

  try {
    // Note: Parent is guaranteed to be processed already due to wave-based processing
    // No need for recursive parent checking

    // Assign frame index
    const iframeFrameIndex = nextFrameIndex.value++;
    playwrightFrameToIndex.set(frame, iframeFrameIndex);

    // Determine parent frame index using map
    const parentFrame = frame.parentFrame();
    const parentFrameIdx = parentFrame
      ? (playwrightFrameToIndex.get(parentFrame) ?? null)
      : null;

    if (debug) {
      console.log(
        `[A11y] Processing OOPIF frame ${iframeFrameIndex} (url=${frame.url()}, parent=${parentFrameIdx})`
      );
    }

    // Enable CDP domains in parallel for better performance
    await Promise.all([
      oopifSession.send("DOM.enable"),
      oopifSession.send("Accessibility.enable"),
    ]);

    // Inject bounding box collection script into OOPIF frame (only if needed)
    if (debug || enableVisualMode) {
      await injectBoundingBoxScript(frame);
    }

    // Build backend ID maps for this OOPIF
    const oopifMaps = await buildBackendIdMaps(
      oopifSession,
      iframeFrameIndex,
      debug
    );

    // Merge maps
    Object.assign(mergedMaps.tagNameMap, oopifMaps.tagNameMap);
    Object.assign(mergedMaps.xpathMap, oopifMaps.xpathMap);
    Object.assign(mergedMaps.accessibleNameMap, oopifMaps.accessibleNameMap);

    // Fetch OOPIF AX tree
    const result = (await oopifSession.send("Accessibility.getFullAXTree")) as {
      nodes: AXNode[];
    };
    let nodes = result.nodes;

    // Fallback to DOM if needed
    if (!hasInteractiveElements(nodes)) {
      if (debug) {
        console.log(
          `[A11y] OOPIF frame ${iframeFrameIndex} has no interactive elements, falling back to DOM`
        );
      }
      const domFallbackNodes = createDOMFallbackNodes(
        iframeFrameIndex,
        mergedMaps.tagNameMap,
        oopifMaps.frameMap || new Map(),
        mergedMaps.accessibleNameMap
      );
      if (domFallbackNodes.length > 0) {
        nodes = domFallbackNodes;
      }
    }

    // Tag and collect nodes
    const taggedNodes = nodes.map((n) => ({
      ...n,
      _frameIndex: iframeFrameIndex,
    }));
    allNodes.push(...taggedNodes);

    // Store in frameMap
    maps.frameMap?.set(iframeFrameIndex, {
      frameIndex: iframeFrameIndex,
      src: frame.url(),
      name: frame.name(),
      xpath: "",
      parentFrameIndex: parentFrameIdx,
      siblingPosition: 0,
      playwrightFrame: frame,
    });

    // Merge nested same-origin iframes from buildBackendIdMaps
    for (const [nestedIdx, nestedInfo] of oopifMaps.frameMap?.entries() || []) {
      maps.frameMap?.set(nestedIdx, nestedInfo);
    }

    if (debug) {
      frameDebugInfo.push({
        frameIndex: iframeFrameIndex,
        frameUrl: frame.url(),
        totalNodes: nodes.length,
        rawNodes: nodes,
      });
    }

    processedOOPIFs.add(frame);
  } finally {
    if (oopifSession) {
      await oopifSession.detach();
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
  page: Page,
  client: CDPSession,
  maps: BackendIdMaps,
  debug: boolean,
  enableVisualMode: boolean
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

  const nextFrameIndex = (maps.frameMap?.size ?? 0) + 1; // Continue from where DOM traversal left off

  // STEP 1: Process same-origin iframes from DOM traversal
  for (const [frameIndex, frameInfo] of maps.frameMap?.entries() ?? []) {
    const { contentDocumentBackendNodeId, src } = frameInfo;

    if (!contentDocumentBackendNodeId) {
      if (debug) {
        console.warn(
          `[A11y] Frame ${frameIndex} has no contentDocumentBackendNodeId, skipping`
        );
      }
      continue;
    }

    try {
      if (debug) {
        console.log(
          `[A11y] Processing same-origin frame ${frameIndex} from DOM traversal`
        );
      }

      // Same-origin: Use main CDP session with contentDocumentBackendNodeId
      // Note: contentDocumentBackendNodeId is unique per iframe
      const result = (await client.send("Accessibility.getPartialAXTree", {
        backendNodeId: contentDocumentBackendNodeId,
        fetchRelatives: true,
      })) as { nodes: AXNode[] };

      let iframeNodes = result.nodes;

      // Fallback to DOM when AX tree has no interactive elements
      if (!hasInteractiveElements(iframeNodes)) {
        if (debug) {
          console.log(
            `[A11y] Frame ${frameIndex} has no interactive elements in AX tree, falling back to DOM`
          );
        }

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

  // STEP 2: Process OOPIF frames using wave-based parallel processing
  // This ensures parents are processed before children while maximizing parallelism
  const allPlaywrightFrames = page.frames();
  const mergedTagNameMap = { ...maps.tagNameMap };
  const mergedXpathMap = { ...maps.xpathMap };
  const mergedAccessibleNameMap = { ...maps.accessibleNameMap };
  const processedOOPIFs = new Set<Frame>();
  const playwrightFrameToIndex = new Map<Frame, number>();
  const nextFrameIndexRef = { value: nextFrameIndex };

  // Build parent-child relationship map for wave-based processing
  const framesByParent = new Map<Frame | null, Frame[]>();
  for (const frame of allPlaywrightFrames) {
    const parent = frame.parentFrame();
    if (!framesByParent.has(parent)) {
      framesByParent.set(parent, []);
    }
    framesByParent.get(parent)!.push(frame);
  }

  // Process frames in waves (BFS style) - all frames at same depth level in parallel
  let currentWave = framesByParent.get(page.mainFrame()) || [];

  while (currentWave.length > 0) {
    // Process all frames in current wave IN PARALLEL
    await Promise.all(
      currentWave.map(frame =>
        processOOPIFRecursive(
          frame,
          page,
          maps,
          allNodes,
          frameDebugInfo,
          {
            tagNameMap: mergedTagNameMap,
            xpathMap: mergedXpathMap,
            accessibleNameMap: mergedAccessibleNameMap,
          },
          nextFrameIndexRef,
          processedOOPIFs,
          playwrightFrameToIndex,
          debug,
          enableVisualMode
        )
      )
    );

    // Collect children for next wave
    const nextWave: Frame[] = [];
    for (const frame of currentWave) {
      const children = framesByParent.get(frame) || [];
      nextWave.push(...children);
    }

    currentWave = nextWave;
  }

  // Update maps with merged values
  maps.tagNameMap = mergedTagNameMap;
  maps.xpathMap = mergedXpathMap;
  maps.accessibleNameMap = mergedAccessibleNameMap;

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
export async function getA11yDOM(
  page: Page,
  debug = false,
  enableVisualMode = false,
  debugDir?: string
): Promise<A11yDOMState> {
  try {
    // Step 1: Inject scripts into the main frame
    const injectionPromises = [injectScrollableDetection(page)];

    // Only inject bounding box script if needed for debug or visual mode
    if (debug || enableVisualMode) {
      injectionPromises.push(injectBoundingBoxScript(page));
    }

    await Promise.all(injectionPromises);

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
        await fetchIframeAXTrees(page, client, maps, debug, enableVisualMode);
      allNodes.push(...iframeNodes);

      // 4c. Build frame hierarchy paths now that all frames are discovered
      buildFramePaths(maps.frameMap || new Map(), debug);

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
          // Get the appropriate Frame for this frameIdx
          let frameContext: Page | Frame = page; // Default to main frame

          if (frameIdx !== 0) {
            // Look up the frame from frameMap
            const frameInfo = maps.frameMap?.get(frameIdx);
            if (frameInfo?.playwrightFrame) {
              frameContext = frameInfo.playwrightFrame;
            }
          }

          const treeResult = await buildHierarchicalTree(
            nodes,
            maps,
            frameIdx,
            scrollableIds,
            debug,
            enableVisualMode,
            frameContext,
            debugDir
          );

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
          for (const [encodedId, rect] of boundingBoxMap.entries()) {
            // Check if box overlaps viewport (accounting for partial visibility)
            const isVisible =
              rect.right > 0 &&
              rect.bottom > 0 &&
              rect.left < viewport.width &&
              rect.top < viewport.height;

            if (isVisible) {
              visibleBoundingBoxMap.set(encodedId, rect);
            }
          }

          visualOverlay = await renderA11yOverlay(visibleBoundingBoxMap, {
            width: viewport.width,
            height: viewport.height,
            showEncodedIds: true,
            colorScheme: "rainbow",
          });

          if (debug) {
            console.log(
              `[A11y Visual] Rendered ${visibleBoundingBoxMap.size} elements (filtered from ${boundingBoxMap.size} total)`
            );
          }
        }
      }

      return {
        elements: allElements,
        domState: combinedDomState,
        xpathMap: allXpaths,
        frameMap: maps.frameMap,
        ...(debug && { frameDebugInfo: processedDebugInfo }),
        ...(enableVisualMode && { boundingBoxMap, visualOverlay }),
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
