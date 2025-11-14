export interface HyperAgentDebugOptions {
  cdpSessions?: boolean;
  traceWait?: boolean;
  profileDomCapture?: boolean;
  structuredSchema?: boolean;
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
