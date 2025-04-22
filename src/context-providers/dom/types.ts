export interface InteractiveElement {
  element: HTMLElement;
  iframe?: HTMLIFrameElement;
  shadowHost?: HTMLElement;
  rect: DOMRect;
  interactiveReason?: string;
  highlightIndex?: number;
  cssPath?: string;
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
  idxToCSSPath: Map<number, string>;
}
