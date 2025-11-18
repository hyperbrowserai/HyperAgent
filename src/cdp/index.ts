export * from "./types";
export {
  getCDPClientForPage,
  getCDPClientForPage as getCDPClient,
  disposeCDPClientForPage,
  disposeAllCDPClients,
} from "./playwright-adapter";
export { getBoundingBox } from "./bounding-box";
export {
  resolveElement,
  ResolvedCDPElement,
  ElementResolveContext,
} from "./element-resolver";
export {
  dispatchCDPAction,
  CDPActionContext,
  CDPActionMethod,
  CDPActionElement,
} from "./interactions";
export { FrameGraph, FrameRecord } from "./frame-graph";
export {
  FrameContextManager,
  getOrCreateFrameContextManager,
} from "./frame-context-manager";
export { isAdOrTrackingFrame, FrameFilterContext } from "./frame-filters";
