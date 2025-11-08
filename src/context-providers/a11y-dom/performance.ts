/**
 * Performance tracking utilities for A11y DOM extraction
 * Provides hierarchical timing with minimal overhead
 */

export interface TimingEntry {
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  children: TimingEntry[];
  metadata?: Record<string, any>;
}

export interface PerformanceReport {
  totalTime: number;
  breakdown: Record<string, any>;
  bottlenecks: Array<{
    operation: string;
    time: number;
    percentage: number;
    severity: 'critical' | 'high' | 'medium' | 'low';
    recommendation: string;
  }>;
  rawTimings: TimingEntry[];
}

/**
 * Performance tracker with hierarchical timing support
 */
export class PerformanceTracker {
  private rootEntry: TimingEntry;
  private currentEntry: TimingEntry;
  private timerStack: TimingEntry[] = [];
  private timerMap: Map<string, TimingEntry> = new Map();

  constructor(name: string = 'root') {
    this.rootEntry = {
      name,
      startTime: performance.now(),
      children: [],
    };
    this.currentEntry = this.rootEntry;
  }

  /**
   * Start a named timer
   */
  startTimer(name: string, metadata?: Record<string, any>): void {
    const entry: TimingEntry = {
      name,
      startTime: performance.now(),
      children: [],
      metadata,
    };

    // Add to current entry's children
    this.currentEntry.children.push(entry);

    // Push to stack and update current
    this.timerStack.push(this.currentEntry);
    this.currentEntry = entry;

    // Store in map for quick access
    this.timerMap.set(name, entry);
  }

  /**
   * Stop a named timer and return duration
   */
  stopTimer(name: string): number {
    const entry = this.timerMap.get(name);
    if (!entry) {
      console.warn(`[Performance] Timer '${name}' not found`);
      return 0;
    }

    // If this timer is not the current one, something went wrong
    if (this.currentEntry !== entry) {
      console.warn(
        `[Performance] Timer '${name}' stopped out of order (current: ${this.currentEntry.name})`
      );
    }

    entry.endTime = performance.now();
    entry.duration = entry.endTime - entry.startTime;

    // Pop back to parent
    if (this.timerStack.length > 0) {
      this.currentEntry = this.timerStack.pop()!;
    }

    return entry.duration;
  }

  /**
   * Record a single point-in-time mark
   */
  mark(name: string, metadata?: Record<string, any>): void {
    const entry: TimingEntry = {
      name,
      startTime: performance.now(),
      endTime: performance.now(),
      duration: 0,
      children: [],
      metadata,
    };

    this.currentEntry.children.push(entry);
  }

  /**
   * End the root timer
   */
  finish(): void {
    if (!this.rootEntry.endTime) {
      this.rootEntry.endTime = performance.now();
      this.rootEntry.duration = this.rootEntry.endTime - this.rootEntry.startTime;
    }
  }

  /**
   * Get flattened timing data
   */
  getFlatTimings(): Array<{ name: string; duration: number; metadata?: Record<string, any> }> {
    const flat: Array<{ name: string; duration: number; metadata?: Record<string, any> }> = [];

    const traverse = (entry: TimingEntry, depth: number = 0) => {
      if (entry.duration !== undefined) {
        flat.push({
          name: '  '.repeat(depth) + entry.name,
          duration: entry.duration,
          metadata: entry.metadata,
        });
      }

      for (const child of entry.children) {
        traverse(child, depth + 1);
      }
    };

    traverse(this.rootEntry);
    return flat;
  }

  /**
   * Build hierarchical breakdown object
   */
  private buildBreakdown(entry: TimingEntry): any {
    if (entry.children.length === 0) {
      return entry.duration ?? 0;
    }

    const breakdown: any = {};

    // If we have both duration and children, include total
    if (entry.duration !== undefined) {
      breakdown.total = entry.duration;
    }

    // Add children
    for (const child of entry.children) {
      breakdown[child.name] = this.buildBreakdown(child);
    }

    return breakdown;
  }

  /**
   * Detect bottlenecks based on timing data
   */
  private detectBottlenecks(totalTime: number): PerformanceReport['bottlenecks'] {
    const bottlenecks: PerformanceReport['bottlenecks'] = [];
    const threshold = {
      critical: 200, // > 200ms
      high: 100, // > 100ms
      medium: 50, // > 50ms
    };

    const traverse = (entry: TimingEntry, path: string = '') => {
      if (!entry.duration) return;

      const fullPath = path ? `${path} > ${entry.name}` : entry.name;
      const percentage = (entry.duration / totalTime) * 100;

      let severity: 'critical' | 'high' | 'medium' | 'low' = 'low';
      let recommendation = '';

      // Determine severity
      if (entry.duration > threshold.critical) {
        severity = 'critical';
        recommendation = `Operation takes ${entry.duration.toFixed(0)}ms. Consider optimization.`;
      } else if (entry.duration > threshold.high) {
        severity = 'high';
        recommendation = `Operation takes ${entry.duration.toFixed(0)}ms. May benefit from optimization.`;
      } else if (entry.duration > threshold.medium && percentage > 10) {
        severity = 'medium';
        recommendation = `Represents ${percentage.toFixed(1)}% of total time.`;
      }

      // Check metadata for bottleneck hints
      if (entry.metadata?.sequential && entry.metadata?.parallelizable) {
        severity = severity === 'low' ? 'high' : severity;
        recommendation += ' Could be parallelized.';
      }

      if (entry.metadata?.cdpCallCount && entry.metadata.cdpCallCount > 10) {
        severity = severity === 'low' ? 'medium' : severity;
        recommendation += ` Makes ${entry.metadata.cdpCallCount} CDP calls.`;
      }

      if (severity !== 'low') {
        bottlenecks.push({
          operation: fullPath,
          time: entry.duration,
          percentage,
          severity,
          recommendation,
        });
      }

      // Recurse through children
      for (const child of entry.children) {
        traverse(child, fullPath);
      }
    };

    traverse(this.rootEntry);

    // Sort by time descending
    bottlenecks.sort((a, b) => b.time - a.time);

    return bottlenecks;
  }

  /**
   * Generate performance report
   */
  getReport(): PerformanceReport {
    this.finish();

    const totalTime = this.rootEntry.duration ?? 0;
    const breakdown = this.buildBreakdown(this.rootEntry);
    const bottlenecks = this.detectBottlenecks(totalTime);

    return {
      totalTime,
      breakdown,
      bottlenecks,
      rawTimings: [this.rootEntry],
    };
  }

  /**
   * Export as JSON
   */
  toJSON(): string {
    return JSON.stringify(this.getReport(), null, 2);
  }

  /**
   * Format report as human-readable string
   */
  formatReport(): string {
    const report = this.getReport();
    const lines: string[] = [];

    lines.push(`\n[A11y Performance] Total time: ${report.totalTime.toFixed(0)}ms\n`);

    // Top bottlenecks
    if (report.bottlenecks.length > 0) {
      lines.push('Top Bottlenecks:');
      report.bottlenecks.slice(0, 5).forEach((b, i) => {
        const icon =
          b.severity === 'critical' ? '🔴' : b.severity === 'high' ? '⚠️ ' : '🔶';
        lines.push(
          `  ${i + 1}. ${icon} ${b.operation.padEnd(40)} ${b.time.toFixed(0)}ms ${b.percentage.toFixed(1)}% → ${b.recommendation}`
        );
      });
      lines.push('');
    }

    // Flat timing breakdown
    lines.push('Timing Breakdown:');
    const flatTimings = this.getFlatTimings();
    for (const { name, duration } of flatTimings) {
      const percentage = ((duration / report.totalTime) * 100).toFixed(1);
      lines.push(`  ${name.padEnd(50)} ${duration.toFixed(0)}ms (${percentage}%)`);
    }

    return lines.join('\n');
  }
}

/**
 * Global tracker instance (optional convenience)
 */
let globalTracker: PerformanceTracker | null = null;

export function getGlobalTracker(): PerformanceTracker | null {
  return globalTracker;
}

export function setGlobalTracker(tracker: PerformanceTracker | null): void {
  globalTracker = tracker;
}

/**
 * Convenience wrapper for timing async operations
 */
export async function withTiming<T>(
  tracker: PerformanceTracker,
  name: string,
  fn: () => Promise<T>,
  metadata?: Record<string, any>
): Promise<T> {
  tracker.startTimer(name, metadata);
  try {
    return await fn();
  } finally {
    tracker.stopTimer(name);
  }
}

/**
 * Convenience wrapper for timing sync operations
 */
export function withTimingSync<T>(
  tracker: PerformanceTracker,
  name: string,
  fn: () => T,
  metadata?: Record<string, any>
): T {
  tracker.startTimer(name, metadata);
  try {
    return fn();
  } finally {
    tracker.stopTimer(name);
  }
}
