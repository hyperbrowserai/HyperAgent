import { TaskStatus } from "@/types";
import { formatUnknownError } from "@/utils";

type PauseableTask = {
  getStatus: () => TaskStatus;
  pause: () => void;
};

type ResumableTask = {
  getStatus: () => TaskStatus;
  resume: () => void;
};

function readTaskMethod<T extends "getStatus" | "pause" | "resume">(
  task: unknown,
  method: T
): () => unknown {
  if (!task || typeof task !== "object") {
    throw new Error("task instance is unavailable");
  }
  let value: unknown;
  try {
    value = (task as Record<string, unknown>)[method];
  } catch (error) {
    throw new Error(
      `task.${method} is inaccessible (${formatUnknownError(error)})`
    );
  }
  if (typeof value !== "function") {
    throw new Error(`task.${method} is not callable`);
  }
  return value.bind(task);
}

export function pauseTaskIfRunning(task?: PauseableTask): boolean {
  if (!task) {
    return false;
  }
  let status: TaskStatus;
  try {
    status = readTaskMethod(task, "getStatus")() as TaskStatus;
  } catch (error) {
    console.warn(
      `[CLI] Failed to read task status for pause: ${formatUnknownError(error)}`
    );
    return false;
  }
  if (status !== TaskStatus.RUNNING) {
    return false;
  }
  try {
    readTaskMethod(task, "pause")();
  } catch (error) {
    console.warn(
      `[CLI] Failed to pause task: ${formatUnknownError(error)}`
    );
    return false;
  }
  return true;
}

export function resumeTaskIfPaused(task?: ResumableTask): boolean {
  if (!task) {
    return false;
  }
  let status: TaskStatus;
  try {
    status = readTaskMethod(task, "getStatus")() as TaskStatus;
  } catch (error) {
    console.warn(
      `[CLI] Failed to read task status for resume: ${formatUnknownError(error)}`
    );
    return false;
  }
  if (status !== TaskStatus.PAUSED) {
    return false;
  }
  try {
    readTaskMethod(task, "resume")();
  } catch (error) {
    console.warn(
      `[CLI] Failed to resume task: ${formatUnknownError(error)}`
    );
    return false;
  }
  return true;
}
