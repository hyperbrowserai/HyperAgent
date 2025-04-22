export interface InteractiveElement {
  element: HTMLElement;
  iframe?: HTMLIFrameElement;
  shadowHost?: HTMLElement;
  isUnderShadowRoot: boolean;
  rect: DOMRect;
  interactiveReason?: string;
  highlightIndex?: number;
  cssPath: string;
  xpath: string;
}

export interface DOMStateRaw {
  elements: InteractiveElement[];
  domState: string;
  screenshot: string;
}

export interface DOMState {
  elements: Map<number, InteractiveElement>;
  domState: string;
  screenshot: string;
}
