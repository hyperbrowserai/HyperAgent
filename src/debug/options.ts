export interface HyperAgentDebugOptions {
  cdpSessions?: boolean;
  traceWait?: boolean;
  profileDomCapture?: boolean;
  structuredSchema?: boolean;
}

const DEBUG_OPTION_KEYS: ReadonlyArray<keyof HyperAgentDebugOptions> = [
  "cdpSessions",
  "traceWait",
  "profileDomCapture",
  "structuredSchema",
];

let currentDebugOptions: HyperAgentDebugOptions = {};
let debugOptionsEnabled = false;

function safeReadOptionField(
  options: unknown,
  key: keyof HyperAgentDebugOptions
): unknown {
  if (!options || (typeof options !== "object" && typeof options !== "function")) {
    return undefined;
  }
  try {
    return (options as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function normalizeDebugOptions(options?: HyperAgentDebugOptions): HyperAgentDebugOptions {
  const normalized: HyperAgentDebugOptions = {};
  for (const key of DEBUG_OPTION_KEYS) {
    const value = safeReadOptionField(options, key);
    if (typeof value === "boolean") {
      normalized[key] = value;
    }
  }
  return normalized;
}

export function setDebugOptions(
  options?: HyperAgentDebugOptions,
  enabled = false
): void {
  currentDebugOptions = normalizeDebugOptions(options);
  debugOptionsEnabled = enabled;
}

export function getDebugOptions(): HyperAgentDebugOptions & { enabled: boolean } {
  return { ...currentDebugOptions, enabled: debugOptionsEnabled };
}
