export interface HyperAgentDebugOptions {
  cdpSessions?: boolean;
  traceWait?: boolean;
  profileDomCapture?: boolean;
  structuredSchema?: boolean;
  /** Directory for debug artifacts. If set, implicitly enables debug mode (P2.3). */
  debugDir?: string;
}

let currentDebugOptions: HyperAgentDebugOptions = {};
let debugOptionsEnabled = false;

export function setDebugOptions(
  options?: HyperAgentDebugOptions,
  enabled = false
): void {
  currentDebugOptions = options ?? {};
  debugOptionsEnabled = enabled;
}

export function getDebugOptions(): HyperAgentDebugOptions & { enabled: boolean } {
  return { ...currentDebugOptions, enabled: debugOptionsEnabled };
}
