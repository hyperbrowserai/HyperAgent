import { ElementHandle, Page } from "playwright-core";

import {
  A11yDOMState,
  AccessibilityNode,
  EncodedId,
} from "@/context-providers/a11y-dom/types";
import {
  formatSimplifiedTree,
  generateFrameHeader,
} from "@/context-providers/a11y-dom/utils";

export type SelectorType = "css" | "xpath";

export interface ScopedDomResult {
  domState: A11yDOMState;
  warning?: string;
  matched: boolean;
}

export function detectSelectorType(
  selector: string,
  selectorType?: SelectorType
): SelectorType {
  if (selectorType) return selectorType;
  const trimmed = selector.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith(".//") || trimmed.startsWith("(")) {
    return "xpath";
  }
  return "css";
}

export async function scopeDomWithSelector(
  page: Page,
  domState: A11yDOMState,
  selector: string,
  selectorType?: SelectorType
): Promise<ScopedDomResult> {
  const resolvedType = detectSelectorType(selector, selectorType);
  const { ids, warning: resolveWarning } = await resolveEncodedIds(
    page,
    domState,
    selector,
    resolvedType
  );

  if (!ids.length) {
    return {
      domState,
      warning:
        resolveWarning ||
        `Selector "${selector}" did not match any nodes; using full DOM snapshot`,
      matched: false,
    };
  }

  const allowedIds = new Set<EncodedId>();
  for (const id of ids) {
    collectDescendants(id, domState.elements, allowedIds);
  }

  const scopedElements = new Map<EncodedId, AccessibilityNode>();
  for (const [id, node] of domState.elements) {
    if (allowedIds.has(id)) {
      scopedElements.set(id, node);
      if (!(node as any).encodedId) {
        (node as any).encodedId = id;
      }
    }
  }

  const scopedXpathMap = Object.entries(domState.xpathMap || {}).reduce(
    (acc, [id, xpath]) => {
      if (allowedIds.has(id as EncodedId)) {
        acc[id as EncodedId] = xpath;
      }
      return acc;
    },
    {} as Record<EncodedId, string>
  );

  const scopedBackendMap = Object.entries(domState.backendNodeMap || {}).reduce(
    (acc, [id, backendId]) => {
      if (allowedIds.has(id as EncodedId)) {
        acc[id as EncodedId] = backendId;
      }
      return acc;
    },
    {} as Record<EncodedId, number>
  );

  const scopedBoundingBoxMap = domState.boundingBoxMap
    ? new Map(
        Array.from(domState.boundingBoxMap.entries()).filter(([id]) =>
          allowedIds.has(id)
        )
      )
    : undefined;

  const frameGroups = new Map<number, EncodedId[]>();
  for (const id of ids) {
    const frameIndex = parseFrameIndex(id);
    const arr = frameGroups.get(frameIndex) ?? [];
    arr.push(id);
    frameGroups.set(frameIndex, arr);
  }

  const frameSections: string[] = [];
  for (const [frameIndex, rootIds] of frameGroups.entries()) {
    const frameInfo = domState.frameMap?.get(frameIndex);
    const header = generateFrameHeader(
      frameIndex,
      frameInfo?.framePath ||
        (frameIndex === 0 ? ["Main"] : [`Frame ${frameIndex}`])
    );
    const content = rootIds
      .map((rootId) => {
        const node = scopedElements.get(rootId);
        return node ? formatSimplifiedTree(node as typeof node) : "";
      })
      .filter(Boolean)
      .join("\n");

    if (content) {
      frameSections.push(`${header}\n${content}`);
    }
  }

  const scopedDomState = frameSections.join("\n\n") || domState.domState;

  const scopedFrameMap = domState.frameMap
    ? new Map(
        Array.from(domState.frameMap.entries()).filter(([frameIdx]) =>
          frameGroups.has(frameIdx)
        )
      )
    : domState.frameMap;

  const scopedFrameDebug = domState.frameDebugInfo
    ? domState.frameDebugInfo.filter((info) =>
        frameGroups.has(info.frameIndex)
      )
    : domState.frameDebugInfo;

  return {
    domState: {
      ...domState,
      elements: scopedElements,
      xpathMap: scopedXpathMap,
      backendNodeMap: scopedBackendMap,
      boundingBoxMap: scopedBoundingBoxMap,
      domState: scopedDomState,
      frameMap: scopedFrameMap,
      frameDebugInfo: scopedFrameDebug,
      visualOverlay: undefined,
    },
    matched: true,
    warning: resolveWarning,
  };
}

async function resolveEncodedIds(
  page: Page,
  domState: A11yDOMState,
  selector: string,
  selectorType: SelectorType
): Promise<{ ids: EncodedId[]; warning?: string }> {
  const frame = page.mainFrame();
  try {
    const handles =
      selectorType === "css"
        ? await frame.$$(selector)
        : await frame.$$(`xpath=${selector}`);

    const hasMultipleFrames = page.frames().length > 1;

    if (!handles.length) {
      return {
        ids: [],
        warning: hasMultipleFrames
          ? "Selector not found on the main frame; multi-frame scoping is not yet supported, using full DOM instead"
          : `Selector "${selector}" not found on the main frame; falling back to full DOM`,
      };
    }

    const xpaths = await Promise.all(
      handles.map((handle) => handleToXPath(handle))
    );
    await Promise.all(handles.map((handle) => handle.dispose().catch(() => {})));

    const matchedIds = Object.entries(domState.xpathMap || {})
      .filter(([id, xpath]) => xpaths.includes(xpath) && id.startsWith("0-"))
      .map(([id]) => id as EncodedId);

    if (!matchedIds.length) {
      return {
        ids: [],
        warning:
          "Selector matched live DOM but could not be aligned with accessibility snapshot; using full DOM",
      };
    }

    return { ids: matchedIds };
  } catch (error) {
    return {
      ids: [],
      warning: `Failed to resolve selector: ${String(error)}`,
    };
  }
}

async function handleToXPath(handle: ElementHandle<Node>): Promise<string> {
  return handle.evaluate((node) => {
    const getIndex = (sibling: Element, name: string): number => {
      const siblings = sibling.parentNode?.children;
      if (!siblings) return 1;
      let index = 0;
      for (const child of Array.from(siblings)) {
        if (child.nodeName === name) {
          index += 1;
        }
        if (child === sibling) {
          return index || 1;
        }
      }
      return 1;
    };

    const buildPath = (el: Node | null): string => {
      if (!el || el.nodeType === Node.DOCUMENT_NODE) return "";
      if (el.nodeType === Node.ELEMENT_NODE) {
        const element = el as Element;
        const tagName = element.tagName.toLowerCase();
        const position = getIndex(element, element.tagName);
        const parentPath = buildPath(el.parentNode);
        const step = `${tagName.toLowerCase()}[${position}]`;
        return parentPath ? `${parentPath}/${step}` : `//${step}`;
      }
      // Text and comment nodes fall back to parent path
      return buildPath(el.parentNode);
    };

    return buildPath(node as Element);
  });
}

function collectDescendants(
  rootId: EncodedId,
  elements: Map<EncodedId, AccessibilityNode>,
  acc: Set<EncodedId>
): void {
  if (acc.has(rootId)) return;
  acc.add(rootId);
  const node = elements.get(rootId) as AccessibilityNode & {
    encodedId?: EncodedId;
    children?: (AccessibilityNode & { encodedId?: EncodedId })[];
  };
  if (!node || !node.children) return;
  for (const child of node.children) {
    const childId = (child as any).encodedId as EncodedId | undefined;
    if (childId) {
      collectDescendants(childId, elements, acc);
    }
  }
}

function parseFrameIndex(encodedId: EncodedId): number {
  const [frameIndex] = encodedId.split("-");
  const parsed = Number.parseInt(frameIndex, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
