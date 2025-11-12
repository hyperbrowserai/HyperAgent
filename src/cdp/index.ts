export * from "./types";
export {
  getCDPClientForPage,
  getCDPClientForPage as getCDPClient,
  disposeCDPClientForPage,
  disposeAllCDPClients,
} from "./playwright-adapter";
export { CdpConnection } from "./connection";
export { getBoundingBox } from "./bounding-box";
export {
  attachDriverToCDP,
  AttachDriverToCDPOptions,
} from "./connector-helpers";
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
