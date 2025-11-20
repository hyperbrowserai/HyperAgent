export type OperationType = "act" | "extract" | "observe";

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
