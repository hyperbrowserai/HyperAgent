export interface HyperAgentDebugOptions {
  cdpSessions?: boolean;
  traceWait?: boolean;
  profileDomCapture?: boolean;
  structuredSchema?: boolean;
}

let currentDebugOptions: HyperAgentDebugOptions = {};

export function setDebugOptions(
  options?: HyperAgentDebugOptions
): void {
  currentDebugOptions = options ?? {};
}

export function getDebugOptions(): HyperAgentDebugOptions {
  return currentDebugOptions;
}
