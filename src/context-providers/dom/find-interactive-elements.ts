import { isIgnoredElem, isInteractiveElem } from "./elem-interactive";
import { InteractiveElement } from "./types";

export const findInteractiveElements = (): InteractiveElement[] => {
  const interactiveElements: InteractiveElement[] = [];
  const processedElements = new Set<HTMLElement>();

  const processRoot = (
    root: Document | ShadowRoot,
    rootInfo: {
      iframe?: HTMLIFrameElement;
      shadowHost?: HTMLElement;
    } = {}
  ) => {
    const elements = root.querySelectorAll("*");
    for (let i = 0; i < elements.length; i++) {
      const element = elements[i] as HTMLElement;
      if (processedElements.has(element)) {
        continue;
      }
      processedElements.add(element);
      if (element.shadowRoot) {
        processRoot(element.shadowRoot, {
          iframe: rootInfo.iframe,
          shadowHost: element,
        });
      }
      const { isInteractive, reason } = isInteractiveElem(element);
      if (isIgnoredElem(element) || !isInteractive) {
        continue;
      }
      interactiveElements.push({
        element,
        iframe: rootInfo.iframe,
        shadowHost: rootInfo.shadowHost,
        rect: element.getBoundingClientRect(),
        interactiveReason: reason,
        isUnderShadowRoot:
          element.getRootNode().nodeType === Node.DOCUMENT_FRAGMENT_NODE,
        cssPath: "",
        xpath: "",
      });
    }
  };

  processRoot(document);

  const iframes = document.querySelectorAll("iframe");
  for (let i = 0; i < iframes.length; i++) {
    const iframe = iframes[i] as HTMLIFrameElement;
    try {
      const iframeDoc =
        iframe.contentDocument || iframe.contentWindow?.document;
      if (iframeDoc) {
        processRoot(iframeDoc, { iframe });
      }
    } catch (e) {
      console.warn("error processing iframe", e);
    }
  }

  return interactiveElements;
};
