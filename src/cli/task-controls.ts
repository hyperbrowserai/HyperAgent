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

export function pauseTaskIfRunning(task?: PauseableTask): boolean {
  if (!task) {
    return false;
  }
  let status: TaskStatus;
  try {
    status = task.getStatus();
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
    task.pause();
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
    status = task.getStatus();
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
    task.resume();
  } catch (error) {
    console.warn(
      `[CLI] Failed to resume task: ${formatUnknownError(error)}`
    );
    return false;
  }
  return true;
}
