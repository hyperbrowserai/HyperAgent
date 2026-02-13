import { TaskStatus } from "@/types";
import { pauseTaskIfRunning, resumeTaskIfPaused } from "@/cli/task-controls";

describe("task-controls helpers", () => {
  it("does nothing when pause is requested without a task", () => {
    expect(pauseTaskIfRunning(undefined)).toBe(false);
  });

  it("pauses only when task is running", () => {
    const pause = jest.fn();
    const runningTask = {
      getStatus: () => TaskStatus.RUNNING,
      pause,
    };
    const pausedTask = {
      getStatus: () => TaskStatus.PAUSED,
      pause,
    };

    expect(pauseTaskIfRunning(runningTask)).toBe(true);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(pauseTaskIfRunning(pausedTask)).toBe(false);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it("does nothing when resume is requested without a task", () => {
    expect(resumeTaskIfPaused(undefined)).toBe(false);
  });

  it("resumes only when task is paused", () => {
    const resume = jest.fn();
    const pausedTask = {
      getStatus: () => TaskStatus.PAUSED,
      resume,
    };
    const runningTask = {
      getStatus: () => TaskStatus.RUNNING,
      resume,
    };

    expect(resumeTaskIfPaused(pausedTask)).toBe(true);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resumeTaskIfPaused(runningTask)).toBe(false);
    expect(resume).toHaveBeenCalledTimes(1);
  });
});
