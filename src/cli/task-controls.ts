import { TaskStatus } from "@/types";

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
  if (task.getStatus() !== TaskStatus.RUNNING) {
    return false;
  }
  task.pause();
  return true;
}

export function resumeTaskIfPaused(task?: ResumableTask): boolean {
  if (!task) {
    return false;
  }
  if (task.getStatus() !== TaskStatus.PAUSED) {
    return false;
  }
  task.resume();
  return true;
}
