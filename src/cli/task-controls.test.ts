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

  it("returns false and warns when getStatus throws", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        pauseTaskIfRunning({
          getStatus: () => {
            throw { reason: "status failed" };
          },
          pause: jest.fn(),
        })
      ).toBe(false);

      expect(
        resumeTaskIfPaused({
          getStatus: () => {
            throw { reason: "status failed" };
          },
          resume: jest.fn(),
        })
      ).toBe(false);

      expect(warnSpy).toHaveBeenCalledWith(
        '[CLI] Failed to read task status for pause: {"reason":"status failed"}'
      );
      expect(warnSpy).toHaveBeenCalledWith(
        '[CLI] Failed to read task status for resume: {"reason":"status failed"}'
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("returns false and warns when pause/resume handlers throw", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        pauseTaskIfRunning({
          getStatus: () => TaskStatus.RUNNING,
          pause: () => {
            throw { reason: "pause failed" };
          },
        })
      ).toBe(false);
      expect(
        resumeTaskIfPaused({
          getStatus: () => TaskStatus.PAUSED,
          resume: () => {
            throw { reason: "resume failed" };
          },
        })
      ).toBe(false);

      expect(warnSpy).toHaveBeenCalledWith(
        '[CLI] Failed to pause task: {"reason":"pause failed"}'
      );
      expect(warnSpy).toHaveBeenCalledWith(
        '[CLI] Failed to resume task: {"reason":"resume failed"}'
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
