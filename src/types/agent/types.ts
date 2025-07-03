import { z } from "zod";
import { ActionOutput } from "./actions/types";
import { Locator, Page } from "playwright";
import { ErrorEmitter } from "@/utils";

export const AgentOutputFn = (
  actionsSchema: z.ZodUnion<readonly [z.AnyZodObject, ...z.AnyZodObject[]]>
) =>
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
  outputSchema?: z.AnyZodObject;
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
  ai: (task: string, params?: TaskParams) => Promise<TaskOutput>;
  aiAsync: (task: string, params?: TaskParams) => Promise<Task>;
  extract<T extends z.AnyZodObject | undefined = undefined>(
    task?: string,
    outputSchema?: T
  ): Promise<T extends z.AnyZodObject ? z.infer<T> : string>;
  getLocator: (querySelector: string, fallbackDescription: string) => Promise<Locator>;
}
