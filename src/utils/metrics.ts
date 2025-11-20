import { HyperMetrics, OperationType, OpMetrics } from "@/types/metrics";

const createEmptyOpMetrics = (): OpMetrics => ({
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
  durationMs: 0,
});

export class MetricsTracker {
  private metrics: HyperMetrics;

  constructor() {
    this.metrics = {
      totals: {
        promptTokens: 0,
        completionTokens: 0,
        durationMs: 0,
      },
      byOp: {
        act: createEmptyOpMetrics(),
        extract: createEmptyOpMetrics(),
        observe: createEmptyOpMetrics(),
      },
      cache: {
        hits: 0,
        misses: 0,
        writes: 0,
      },
    };
  }

  public recordOperation(
    opType: OperationType,
    params: {
      promptTokens?: number;
      completionTokens?: number;
      reasoningTokens?: number;
      durationMs?: number;
    } = {}
  ): void {
    const opMetrics = this.metrics.byOp[opType];
    opMetrics.calls += 1;

    const promptTokens = params.promptTokens ?? 0;
    const completionTokens = params.completionTokens ?? 0;
    const durationMs = params.durationMs ?? 0;

    opMetrics.promptTokens += promptTokens;
    opMetrics.completionTokens += completionTokens;
    opMetrics.durationMs += durationMs;

    this.metrics.totals.promptTokens += promptTokens;
    this.metrics.totals.completionTokens += completionTokens;
    this.metrics.totals.durationMs += durationMs;

    if (typeof params.reasoningTokens === "number") {
      const prev = this.metrics.totals.reasoningTokens ?? 0;
      this.metrics.totals.reasoningTokens = prev + params.reasoningTokens;
    }
  }

  public recordCacheHit(): void {
    this.metrics.cache.hits += 1;
  }

  public recordCacheMiss(): void {
    this.metrics.cache.misses += 1;
  }

  public recordCacheWrite(): void {
    this.metrics.cache.writes += 1;
  }

  public reset(): void {
    this.metrics.byOp = {
      act: createEmptyOpMetrics(),
      extract: createEmptyOpMetrics(),
      observe: createEmptyOpMetrics(),
    };
    this.metrics.totals = {
      promptTokens: 0,
      completionTokens: 0,
      durationMs: 0,
    };
    this.metrics.cache = { hits: 0, misses: 0, writes: 0 };
  }

  public snapshot(): HyperMetrics {
    return {
      totals: { ...this.metrics.totals },
      byOp: {
        act: { ...this.metrics.byOp.act },
        extract: { ...this.metrics.byOp.extract },
        observe: { ...this.metrics.byOp.observe },
      },
      cache: { ...this.metrics.cache },
    };
  }
}
