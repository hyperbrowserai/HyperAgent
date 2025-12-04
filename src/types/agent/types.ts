import { z } from "zod";
import { ActionOutput } from "./actions/types";
import { Page } from "playwright-core";
import { ErrorEmitter } from "@/utils";

export const AgentOutputFn = (
  actionsSchema: z.ZodUnion<
    readonly [z.ZodType<any>, ...z.ZodType<any>[]]
  >
) =>
  z.object({
    thoughts: z
      .string()
      .describe(
        "Your reasoning about the current state and what needs to be done next based on the task goal and previous actions"
      ),
    memory: z
      .string()
      .describe(
        "A summary of successful actions completed so far and the resulting state changes (e.g., 'Clicked login button -> login form appeared', 'Filled email field with user@example.com')"
      ),
    action: actionsSchema,
  });

export type AgentOutput = z.infer<ReturnType<typeof AgentOutputFn>>;

export interface AgentStep {
  idx: number;
  agentOutput: AgentOutput;
  actionOutput: ActionOutput;
}

/**
 * Cache strategy for action caching
 *
 * - 'none': Never cache this action (default for actions with side effects)
 * - 'result-only': Cache success/failure result, still execute action on hit
 * - 'full': Cache and skip execution on hit (only for idempotent actions)
 */
export type ActionCacheStrategy = "none" | "result-only" | "full";

export interface TaskParams {
  maxSteps?: number;
  debugDir?: string;
  outputSchema?: z.ZodType<any>;
  onStep?: (step: AgentStep) => Promise<void> | void;
  onComplete?: (output: TaskOutput) => Promise<void> | void;
  debugOnAgentOutput?: (step: AgentOutput) => void;
  enableVisualMode?: boolean;
  useDomCache?: boolean;
  enableDomStreaming?: boolean;
  selector?: string;
  selectorType?: "css" | "xpath";
  /**
   * Explicitly specify the operation type.
   * If not provided, defaults to "extract" when outputSchema is present, otherwise "act".
   * Use this to ensure extract behavior (selector scoping, caching) even without a schema.
   */
  opType?: "extract" | "act";
  /**
   * Cache strategy for actions (only applies to opType === 'act')
   *
   * - 'none': Never cache (default, safe for side effects)
   * - 'result-only': Cache result but still execute action
   * - 'full': Cache and skip execution on hit (idempotent actions only)
   */
  cacheStrategy?: ActionCacheStrategy;
}

export interface TaskOutput {
  status?: TaskStatus;
  steps: AgentStep[];
  output?: string;
}

export interface Task {
  getStatus: () => TaskStatus;
  pause: () => TaskStatus;
  resume: () => TaskStatus;
  cancel: () => TaskStatus;
  emitter: ErrorEmitter;
}

export enum TaskStatus {
  PENDING = "pending",
  RUNNING = "running",
  PAUSED = "paused",
  CANCELLED = "cancelled",
  COMPLETED = "completed",
  FAILED = "failed",
}

export const endTaskStatuses = new Set([
  TaskStatus.CANCELLED,
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
]);

export interface TaskState {
  id: string;
  task: string;
  status: TaskStatus;
  startingPage: Page;
  steps: AgentStep[];
  output?: string;
  error?: string;
}

export interface HyperVariable {
  key: string;
  value: string;
  description: string;
}

export interface HyperPage extends Page {
  /**
   * Execute a complex multi-step task using visual mode
   * Best for: Complex workflows, multi-step tasks, exploratory automation
   * Mode: Always visual (screenshots with overlays)
   */
  ai: (task: string, params?: TaskParams) => Promise<TaskOutput>;

  /**
   * Execute a single granular action using a11y mode
   * Best for: Single actions like "click login", "fill email with test@example.com"
   * Mode: Always a11y (accessibility tree, faster and more reliable)
   */
  aiAction: (instruction: string, params?: TaskParams) => Promise<TaskOutput>;

  aiAsync: (task: string, params?: TaskParams) => Promise<Task>;
  extract<T extends z.ZodType<any> | undefined = undefined>(
    task?: string,
    outputSchema?: T,
    params?: Omit<TaskParams, "outputSchema">
  ): Promise<T extends z.ZodType<any> ? z.infer<T> : string>;
}
