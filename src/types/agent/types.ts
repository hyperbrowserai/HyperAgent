import { z } from "zod";
import { ActionOutput } from "./actions/types";
import { Page } from "playwright-core";
import { ErrorEmitter } from "@/utils";

export const AgentOutputFn = (
  actionsSchema: z.ZodUnion<readonly [z.ZodType<any>, ...z.ZodType<any>[]]>
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

export interface ActionCacheEntry {
  stepIndex: number;
  instruction: string;
  elementId: string | null;
  method: string | null;
  arguments: string[];
  actionParams?: Record<string, unknown>;
  frameIndex: number | null;
  xpath: string | null;
  actionType: string;
  success: boolean;
  message: string;
}

export interface CachedActionHint {
  actionType: string;
  xpath?: string | null;
  frameIndex?: number | null;
  method?: string | null;
  arguments?: string[];
  elementId?: string | null;
  actionParams?: Record<string, unknown>;
}

export interface ReplayStepMeta {
  usedCachedAction: boolean;
  fallbackUsed: boolean;
  retries?: number;
  cachedXPath?: string | null;
  fallbackXPath?: string | null;
  fallbackElementId?: string | null;
}

export interface ActionCacheOutput {
  taskId: string;
  createdAt: string;
  status?: TaskStatus;
  steps: ActionCacheEntry[];
}

export interface ActionCacheReplayStepResult {
  stepIndex: number;
  actionType: string;
  usedXPath: boolean;
  fallbackUsed: boolean;
  cachedXPath?: string | null;
  fallbackXPath?: string | null;
  fallbackElementId?: string | null;
  retries: number;
  success: boolean;
  message: string;
}

export interface ActionCacheReplayResult {
  replayId: string;
  sourceTaskId: string;
  steps: ActionCacheReplayStepResult[];
  status: TaskStatus.COMPLETED | TaskStatus.FAILED;
}

export interface RunFromActionCacheParams {
  maxXPathRetries?: number;
  debug?: boolean;
}

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
}

export interface TaskOutput {
  taskId: string;
  status?: TaskStatus;
  steps: AgentStep[];
  output?: string;
  actionCache?: ActionCacheOutput;
  replayStepMeta?: ReplayStepMeta;
}

// Returned by full agent runs (e.g., page.ai()) where actionCache is always populated.
export type AgentTaskOutput = TaskOutput & { actionCache: ActionCacheOutput };

export interface Task {
  id: string;
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

export interface AgentDeps {
  debug?: boolean;
  tokenLimit: number;
  llm: any;
  mcpClient: any;
  variables: Array<{ key: string; value: string; description: string }>;
  cdpActionsEnabled?: boolean;
}
export interface HyperVariable {
  key: string;
  value: string;
  description: string;
}

/**
 * Common options for all perform* helper methods on HyperPage.
 */
export interface PerformOptions {
  frameIndex?: number | null;
  performInstruction?: string | null;
  maxSteps?: number;
}

export interface HyperPage extends Page {
  performClick: (xpath: string, options?: PerformOptions) => Promise<TaskOutput>;
  performHover: (xpath: string, options?: PerformOptions) => Promise<TaskOutput>;
  performType: (
    xpath: string,
    text: string,
    options?: PerformOptions
  ) => Promise<TaskOutput>;
  performFill: (
    xpath: string,
    text: string,
    options?: PerformOptions
  ) => Promise<TaskOutput>;
  performPress: (
    xpath: string,
    key: string,
    options?: PerformOptions
  ) => Promise<TaskOutput>;
  performSelectOption: (
    xpath: string,
    option: string,
    options?: PerformOptions
  ) => Promise<TaskOutput>;
  performCheck: (xpath: string, options?: PerformOptions) => Promise<TaskOutput>;
  performUncheck: (xpath: string, options?: PerformOptions) => Promise<TaskOutput>;
  performScrollToElement: (
    xpath: string,
    options?: PerformOptions
  ) => Promise<TaskOutput>;
  performScrollToPercentage: (
    xpath: string,
    position: string | number,
    options?: PerformOptions
  ) => Promise<TaskOutput>;
  performNextChunk: (xpath: string, options?: PerformOptions) => Promise<TaskOutput>;
  performPrevChunk: (xpath: string, options?: PerformOptions) => Promise<TaskOutput>;
  /**
   * Execute a complex multi-step task using visual mode
   * Best for: Complex workflows, multi-step tasks, exploratory automation
   * Mode: Always visual (screenshots with overlays)
   */
  ai: (task: string, params?: TaskParams) => Promise<AgentTaskOutput>;

  /**
   * Execute a single granular action using a11y mode
   * Best for: Single actions like "click login", "fill email with test@example.com"
   * Mode: Always a11y (accessibility tree, faster and more reliable)
   */
  perform: (instruction: string, params?: TaskParams) => Promise<TaskOutput>;

  /**
   * @deprecated: use perform() instead.
   * Execute a single granular action using a11y mode
   */
  aiAction: (instruction: string, params?: TaskParams) => Promise<TaskOutput>;

  aiAsync: (task: string, params?: TaskParams) => Promise<Task>;
  extract<T extends z.ZodType<any> | undefined = undefined>(
    task?: string,
    outputSchema?: T,
    params?: Omit<TaskParams, "outputSchema">
  ): Promise<T extends z.ZodType<any> ? z.infer<T> : string>;
  getActionCache: (taskId: string) => ActionCacheOutput | null;
  runFromActionCache: (
    cache: ActionCacheOutput,
    params?: RunFromActionCacheParams
  ) => Promise<ActionCacheReplayResult>;
}
