export type OperationType = "act" | "extract" | "observe";

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
}

export interface OpMetrics {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}

export interface HyperMetrics {
  totals: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens?: number;
    durationMs: number;
  };
  byOp: {
    act: OpMetrics;
    extract: OpMetrics;
    observe: OpMetrics;
  };
  cache: {
    hits: number;
    misses: number;
    writes: number;
  };
}

export interface InferenceLogEntry {
  ts: string;
  opType: OperationType;
  model: string;
  cacheHit: boolean;
  prompt: unknown;
  response: unknown;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  durationMs?: number;
  url?: string;
  instruction?: string;
  selector?: string;
}
