import { z } from "zod";
import { ActionOutput } from "./actions/types";
import { Page } from "patchright";
import { ErrorEmitter } from "@/utils";

export const AgentOutputFn = (actionsSchema: z.ZodUnion<readonly [z.ZodType<any>, ...z.ZodType<any>[]]>) =>
  z.object({
    thoughts: z
      .string()
      .describe(
        "Your thoughts on the task at hand, was the previous goal successful?"
      ),
    memory: z
      .string()
      .describe(
        "Information that you need to remember to accomplish subsequent goals"
      ),
    nextGoal: z
      .string()
      .describe(
        "The next goal you are trying to accomplish with the actions you have chosen"
      ),
    actions: z.array(actionsSchema),
  });

export type AgentOutput = z.infer<ReturnType<typeof AgentOutputFn>>;

export interface AgentStep {
  idx: number;
  agentOutput: AgentOutput;
  actionOutputs: ActionOutput[];
}

export interface TaskParams {
  maxSteps?: number;
  debugDir?: string;
  outputSchema?: z.ZodType<any>;
  onStep?: (step: AgentStep) => Promise<void> | void;
  onComplete?: (output: TaskOutput) => Promise<void> | void;
  debugOnAgentOutput?: (step: AgentOutput) => void;
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
  aiAction: (instruction: string) => Promise<TaskOutput>;

  aiAsync: (task: string, params?: TaskParams) => Promise<Task>;
  extract<T extends z.ZodType<any> | undefined = undefined>(
    task?: string,
    outputSchema?: T,
    params?: Omit<TaskParams, "outputSchema">
  ): Promise<T extends z.ZodType<any> ? z.infer<T> : string>;
}
