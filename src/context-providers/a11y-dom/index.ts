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
  IframeInfo,
} from "./types";
import { buildBackendIdMaps } from "./build-maps";
import { buildHierarchicalTree } from "./build-tree";
import {
  injectScrollableDetection,
  findScrollableElementIds,
} from "./scrollable-detection";
import { hasInteractiveElements, createDOMFallbackNodes } from "./utils";

/**
 * Verify if an iframe element matches the frameInfo metadata
 * Uses iframe attributes and XPath verification
 */
async function verifyFrameMatch(
  parentFrame: ReturnType<Page["frames"]>[number],
  iframeElement: any,
  frameInfo: IframeInfo
): Promise<boolean> {
  try {
    // Get iframe attributes
    const src = await iframeElement.getAttribute("src");
    const name = await iframeElement.getAttribute("name");

    // Match by src (most reliable for loaded iframes)
    if (frameInfo.src && src && src === frameInfo.src) {
      return true;
    }

    // Match by name
    if (frameInfo.name && name && name === frameInfo.name) {
      return true;
    }

    // Match by XPath (as last resort)
    if (frameInfo.xpath) {
      const matchesByXPath = await parentFrame.evaluate(
        ({ xpath, element }) => {
          try {
            const result = document.evaluate(
              xpath,
              document,
              null,
              XPathResult.FIRST_ORDERED_NODE_TYPE,
              null
            );
            return result.singleNodeValue === element;
          } catch {
            return false;
          }
        },
        { xpath: frameInfo.xpath, element: iframeElement }
      );
      return matchesByXPath;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Match Playwright Frames to frameMap entries
 * Links each same-origin iframe in frameMap to its corresponding Playwright Frame
 * This enables unified frame resolution using playwrightFrame for all frame types
 */
async function matchPlaywrightFramesToFrameMap(
  page: Page,
  frameMap: Map<number, IframeInfo>,
  debug: boolean
): Promise<void> {
  const allFrames = page.frames();
  const matchedPwFrames = new Set<ReturnType<typeof page.frames>[number]>();

  if (debug) {
    console.log(
      `[A11y] Matching ${allFrames.length} Playwright Frames to ${frameMap.size} frameMap entries`
    );
  }

  // Skip frame 0 (main frame) and frames that already have playwrightFrame (OOPIF)
  for (const [frameIndex, frameInfo] of frameMap) {
    if (frameIndex === 0) continue; // Main frame doesn't need matching
    if (frameInfo.playwrightFrame) continue; // Already set (OOPIF)

    // Determine expected parent frame
    let expectedParentFrame: ReturnType<typeof page.frames>[number] | null;
    if (frameInfo.parentFrameIndex === 0) {
      expectedParentFrame = page.mainFrame();
    } else {
      const parentInfo = frameMap.get(frameInfo.parentFrameIndex);
      expectedParentFrame = parentInfo?.playwrightFrame || null;

      // If parent hasn't been matched yet, skip this frame for now
      if (!expectedParentFrame) {
        if (debug) {
          console.warn(
            `[A11y] ⊘ Skipping frame ${frameIndex} - parent frame ${frameInfo.parentFrameIndex} not matched yet`
          );
        }
        continue;
      }
    }

    let matchedFrame: ReturnType<typeof page.frames>[number] | null = null;

    // Try to match this frameInfo to a Playwright Frame
    for (const pwFrame of allFrames) {
      try {
        // Skip main frame
        if (pwFrame === page.mainFrame()) continue;

        // Skip frames that have already been matched to another frameInfo entry
        if (matchedPwFrames.has(pwFrame)) continue;

        // Get iframe element and its parent frame
        const iframeElement = await pwFrame.frameElement();
        if (!iframeElement) continue;

        const pwParentFrame = pwFrame.parentFrame();
        if (!pwParentFrame) continue;

        // Verify parent matches expected parent
        if (pwParentFrame !== expectedParentFrame) continue;

        // Verify this frame matches our frameInfo (src, name, xpath)
        const matches = await verifyFrameMatch(
          pwParentFrame,
          iframeElement,
          frameInfo
        );

        if (matches) {
          matchedFrame = pwFrame;
          matchedPwFrames.add(pwFrame); // Mark this Playwright Frame as matched
          break;
        }
      } catch (error) {
        // Frame might be detached or inaccessible, continue
        continue;
      }
    }

    if (matchedFrame) {
      frameInfo.playwrightFrame = matchedFrame;
      if (debug) {
        console.log(
          `[A11y] ✓ Matched frame ${frameIndex} to Playwright Frame: ${matchedFrame.url()}`
        );
      }
    } else if (debug) {
      console.warn(
        `[A11y] ✗ Could not match frame ${frameIndex} (src=${frameInfo.src}, name=${frameInfo.name}, parent=${frameInfo.parentFrameIndex})`
      );
    }
  }
}

/**
 * Fetch accessibility trees for all iframes in the page
 * @param client CDP session
 * @param maps Backend ID maps containing frame metadata
 * @param debug Whether to collect debug information
 * @returns Tagged nodes and optional debug info
 */
async function fetchIframeAXTrees(
  page: Page,
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

  let nextFrameIndex = (maps.frameMap?.size ?? 0) + 1; // Continue from where DOM traversal left off

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

  // STEP 2: Discover and process OOPIF frames using Playwright
  const allPlaywrightFrames = page.frames();
  const mergedTagNameMap = { ...maps.tagNameMap };
  const mergedXpathMap = { ...maps.xpathMap };
  const mergedAccessibleNameMap = { ...maps.accessibleNameMap };

  for (const playwrightFrame of allPlaywrightFrames) {
    // Skip main frame
    if (playwrightFrame === page.mainFrame()) continue;

    // Try to create CDP session - if successful, it's an OOPIF
    let oopifSession: CDPSession | null = null;
    try {
      oopifSession = await page.context().newCDPSession(playwrightFrame);
    } catch {
      // Not an OOPIF, skip (already processed in STEP 1)
      continue;
    }

    // This is an OOPIF - process it with separate session
    const iframeFrameIndex = nextFrameIndex++;
    const frameUrl = playwrightFrame.url();

    try {
      if (debug) {
        console.log(
          `[A11y] Processing OOPIF frame ${iframeFrameIndex} (url=${frameUrl})`
        );
      }

      // Enable CDP domains for OOPIF session
      await oopifSession.send("DOM.enable");
      await oopifSession.send("Accessibility.enable");

      // Build backend ID maps for this OOPIF
      const oopifMaps = await buildBackendIdMaps(
        oopifSession,
        iframeFrameIndex,
        debug
      );

      // Merge maps
      Object.assign(mergedTagNameMap, oopifMaps.tagNameMap);
      Object.assign(mergedXpathMap, oopifMaps.xpathMap);
      Object.assign(mergedAccessibleNameMap, oopifMaps.accessibleNameMap);

      // Fetch OOPIF root frame AX tree using getFullAXTree
      const rootResult = (await oopifSession.send(
        "Accessibility.getFullAXTree"
      )) as { nodes: AXNode[] };

      let oopifRootNodes = rootResult.nodes;

      // Fallback to DOM when AX tree has no interactive elements
      if (!hasInteractiveElements(oopifRootNodes)) {
        if (debug) {
          console.log(
            `[A11y] OOPIF frame ${iframeFrameIndex} has no interactive elements in AX tree, falling back to DOM`
          );
        }

        const domFallbackNodes = createDOMFallbackNodes(
          iframeFrameIndex,
          mergedTagNameMap,
          oopifMaps.frameMap || new Map(),
          mergedAccessibleNameMap
        );

        if (domFallbackNodes.length > 0) {
          oopifRootNodes = domFallbackNodes;
        }
      }

      // Tag root nodes with OOPIF frame index
      const taggedRootNodes = oopifRootNodes.map((n) => ({
        ...n,
        _frameIndex: iframeFrameIndex,
      }));

      allNodes.push(...taggedRootNodes);

      // Collect debug info for OOPIF root
      if (debug) {
        frameDebugInfo.push({
          frameIndex: iframeFrameIndex,
          frameUrl: frameUrl,
          totalNodes: oopifRootNodes.length,
          rawNodes: oopifRootNodes,
        });
      }

      // Process nested same-origin iframes within OOPIF (using OOPIF session)
      if (oopifMaps.frameMap && oopifMaps.frameMap.size > 0) {
        if (debug) {
          console.log(
            `[A11y] Processing ${oopifMaps.frameMap.size} nested frames within OOPIF ${iframeFrameIndex}`
          );
        }

        for (const [nestedFrameIndex, nestedFrameInfo] of oopifMaps.frameMap) {
          const { contentDocumentBackendNodeId, src } = nestedFrameInfo;

          if (!contentDocumentBackendNodeId) {
            if (debug) {
              console.warn(
                `[A11y] Nested frame ${nestedFrameIndex} in OOPIF ${iframeFrameIndex} has no contentDocumentBackendNodeId, skipping`
              );
            }
            continue;
          }

          try {
            if (debug) {
              console.log(
                `[A11y] Processing nested frame ${nestedFrameIndex} within OOPIF ${iframeFrameIndex} (src=${src})`
              );
            }

            // Use OOPIF session with nested frame's contentDocumentBackendNodeId
            const nestedResult = (await oopifSession.send(
              "Accessibility.getPartialAXTree",
              {
                backendNodeId: contentDocumentBackendNodeId,
                fetchRelatives: true,
              }
            )) as { nodes: AXNode[] };

            let nestedNodes = nestedResult.nodes;

            // Fallback to DOM when AX tree has no interactive elements
            if (!hasInteractiveElements(nestedNodes)) {
              if (debug) {
                console.log(
                  `[A11y] Nested frame ${nestedFrameIndex} has no interactive elements in AX tree, falling back to DOM`
                );
              }

              const domFallbackNodes = createDOMFallbackNodes(
                nestedFrameIndex,
                mergedTagNameMap,
                oopifMaps.frameMap,
                mergedAccessibleNameMap
              );

              if (domFallbackNodes.length > 0) {
                nestedNodes = domFallbackNodes;
              }
            }

            // Tag nodes with nested frame index
            const taggedNestedNodes = nestedNodes.map((n) => ({
              ...n,
              _frameIndex: nestedFrameIndex,
            }));

            allNodes.push(...taggedNestedNodes);

            // Merge nested frame into main frameMap
            maps.frameMap?.set(nestedFrameIndex, nestedFrameInfo);

            // Collect debug info
            if (debug) {
              frameDebugInfo.push({
                frameIndex: nestedFrameIndex,
                frameUrl: src || "unknown",
                totalNodes: nestedNodes.length,
                rawNodes: nestedNodes,
              });
            }
          } catch (error) {
            console.warn(
              `[A11y] Failed to fetch AX tree for nested frame ${nestedFrameIndex} in OOPIF ${iframeFrameIndex}:`,
              (error as Error).message || error
            );
          }
        }
      }

      // Store OOPIF root metadata in frameMap with Playwright Frame reference
      maps.frameMap?.set(iframeFrameIndex, {
        frameIndex: iframeFrameIndex,
        src: frameUrl,
        name: playwrightFrame.name(),
        xpath: "", // No XPath for OOPIF (cross-origin)
        parentFrameIndex: 0, // TODO: Detect actual parent frame
        siblingPosition: 0, // TODO: Compute sibling position
        playwrightFrame, // Store Frame for frame resolution
      });

      // Update nextFrameIndex to account for any nested frames we just merged
      // This prevents frameIndex collisions when processing subsequent OOPIF frames
      nextFrameIndex = Math.max(nextFrameIndex, ...Array.from(maps.frameMap?.keys() ?? [])) + 1;
    } catch (error) {
      console.warn(
        `[A11y] Failed to fetch AX tree for OOPIF frame ${iframeFrameIndex} (url=${frameUrl}):`,
        (error as Error).message || error
      );
    } finally {
      await oopifSession.detach();
    }
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

      // Step 3.5: Match Playwright Frames to same-origin frameMap entries
      // This enables unified frame resolution using playwrightFrame for all frame types
      await matchPlaywrightFramesToFrameMap(page, maps.frameMap || new Map(), debug);

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
        await fetchIframeAXTrees(page, client, maps, debug);
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
            scrollableIds,
            debug
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
