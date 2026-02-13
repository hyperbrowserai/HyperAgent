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

  it("returns false and warns when task methods are not callable", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        pauseTaskIfRunning({
          getStatus: "running",
          pause: jest.fn(),
        } as unknown as Parameters<typeof pauseTaskIfRunning>[0])
      ).toBe(false);
      expect(
        pauseTaskIfRunning({
          getStatus: () => TaskStatus.RUNNING,
          pause: "not-a-function",
        } as unknown as Parameters<typeof pauseTaskIfRunning>[0])
      ).toBe(false);

      expect(
        resumeTaskIfPaused({
          getStatus: "paused",
          resume: jest.fn(),
        } as unknown as Parameters<typeof resumeTaskIfPaused>[0])
      ).toBe(false);
      expect(
        resumeTaskIfPaused({
          getStatus: () => TaskStatus.PAUSED,
          resume: "not-a-function",
        } as unknown as Parameters<typeof resumeTaskIfPaused>[0])
      ).toBe(false);

      expect(warnSpy).toHaveBeenCalledWith(
        "[CLI] Failed to read task status for pause: task.getStatus is not callable"
      );
      expect(warnSpy).toHaveBeenCalledWith(
        "[CLI] Failed to pause task: task.pause is not callable"
      );
      expect(warnSpy).toHaveBeenCalledWith(
        "[CLI] Failed to read task status for resume: task.getStatus is not callable"
      );
      expect(warnSpy).toHaveBeenCalledWith(
        "[CLI] Failed to resume task: task.resume is not callable"
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("returns false and warns when task method getters are trap-prone", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const pauseTask = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "getStatus") {
            throw new Error("status trap");
          }
          return undefined;
        },
      }
    );
    const resumeTask = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "resume") {
            throw new Error("resume trap");
          }
          if (prop === "getStatus") {
            return () => TaskStatus.PAUSED;
          }
          return undefined;
        },
      }
    );
    try {
      expect(
        pauseTaskIfRunning(
          pauseTask as unknown as Parameters<typeof pauseTaskIfRunning>[0]
        )
      ).toBe(false);
      expect(
        resumeTaskIfPaused(
          resumeTask as unknown as Parameters<typeof resumeTaskIfPaused>[0]
        )
      ).toBe(false);

      expect(warnSpy).toHaveBeenCalledWith(
        "[CLI] Failed to read task status for pause: task.getStatus is inaccessible (status trap)"
      );
      expect(warnSpy).toHaveBeenCalledWith(
        "[CLI] Failed to resume task: task.resume is inaccessible (resume trap)"
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("sanitizes and truncates oversized task-control diagnostics", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const oversizedError = new Error(`status\u0000\n${"x".repeat(10_000)}`);
    try {
      expect(
        pauseTaskIfRunning({
          getStatus: () => {
            throw oversizedError;
          },
          pause: jest.fn(),
        })
      ).toBe(false);

      const warning = warnSpy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes("Failed to read task status for pause"));
      expect(warning).toBeDefined();
      expect(warning).toContain("[truncated");
      expect(warning).not.toContain("\u0000");
      expect(warning).not.toContain("\n");
      expect(warning?.length ?? 0).toBeLessThan(2_500);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
