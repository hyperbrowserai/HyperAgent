import { z } from "zod";
import { ActionOutput } from "./actions/types";
import { Locator, Page } from "playwright";
import { ErrorEmitter } from "@/utils";

export const ExtractedVariable = z.object({
  key: z
    .string()
    .regex(
      /^[a-z][a-z0-9_]*$/,
      "Key must be in snake_case format (lowercase letters, numbers, and underscores only, starting with a letter)",
    )
    .describe(`The key MUST match the variable references in the extraction objective.
    If objective contains <<from_country>>, key should be based on that (e.g., 'capital_of_from_country')
    If objective contains <<to_country>>, key should be based on that (e.g., 'capital_of_to_country')
    NEVER use actual values like country/city names in the key.
    WRONG: 'capital_of_italy', 'capital_of_yemen'
    CORRECT: 'capital_of_top_country_1', 'capital_of_top_country_2'`),
  value: z.string().describe("The actual extracted value from the page."),
  description: z.string()
    .describe(`Generic description using variable references. 
    CORRECT: "The capital of <<top_country_1>>"
    WRONG: "The capital of Yemen"
    NEVER include actual values in descriptions.`),
});

export const VariableExtractionOutput = z.object({
  variables: z
    .array(ExtractedVariable)
    .describe(
      "List of extracted key-value pairs from the page that you will need in your future actions.",
    ),
});

export const AgentOutputFn = (
  actionsSchema: z.ZodUnion<readonly [z.AnyZodObject, ...z.AnyZodObject[]]>,
) =>
  z.object({
    thoughts: z
      .string()
      .describe(
        "Your thoughts on the task at hand, was the previous goal successful?",
      ),
    memory: z
      .string()
      .describe(
        "Information that you need to remember to accomplish subsequent goals",
      ),
    nextGoal: z
      .string()
      .describe(
        "The next goal you are trying to accomplish with the actions you have chosen",
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
    outputSchema?: T,
  ): Promise<T extends z.AnyZodObject ? z.infer<T> : string>;
  getLocator: (
    querySelector: string,
    fallbackDescription: string,
  ) => Promise<Locator>;
}
