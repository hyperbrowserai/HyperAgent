export interface InteractiveElement {
  element: HTMLElement;
  iframe?: HTMLIFrameElement;
  shadowHost?: HTMLElement;
  rect: DOMRect;
  interactiveReason?: string;
  highlightIndex?: number;
  xPath?: string;
}

export interface DOMStateRaw {
  elements: InteractiveElement[];
  domState: string;
  screenshot: string;
}

export interface DOMState {
  elements: InteractiveElement[];
  domState: string;
  screenshot: string;
  idxToXPath: Map<number, string>;
}
