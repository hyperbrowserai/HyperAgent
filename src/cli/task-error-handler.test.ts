import { EventEmitter } from "node:events";
import type { Task } from "@/types";
import { attachTaskErrorHandler } from "@/cli/task-error-handler";

describe("attachTaskErrorHandler", () => {
  it("cancels task and forwards error payloads to callback", () => {
    const emitter = new EventEmitter();
    const cancel = jest.fn();
    const onError = jest.fn();
    const task = {
      cancel,
      emitter,
    } as unknown as Task;

    attachTaskErrorHandler(task, onError);

    const errorPayload = { reason: "task failed" };
    emitter.emit("error", errorPayload);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(errorPayload);
  });

  it("logs readable message when error callback itself throws", () => {
    const emitter = new EventEmitter();
    const cancel = jest.fn();
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const task = {
      cancel,
      emitter,
    } as unknown as Task;

    try {
      attachTaskErrorHandler(task, () => {
        throw { reason: "callback blew up" };
      });

      emitter.emit("error", { reason: "task failed" });

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        '[CLI] Task error handler failed: {"reason":"callback blew up"}'
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("handles only the first emitted task error", () => {
    const emitter = new EventEmitter();
    const cancel = jest.fn();
    const onError = jest.fn();
    const task = {
      cancel,
      emitter,
    } as unknown as Task;

    attachTaskErrorHandler(task, onError);

    emitter.emit("error", { reason: "first" });
    emitter.emit("error", { reason: "second" });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith({ reason: "first" });
  });

  it("logs cancellation failures but still forwards error to callback", () => {
    const emitter = new EventEmitter();
    const cancel = jest.fn(() => {
      throw { reason: "cancel failed" };
    });
    const onError = jest.fn();
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const task = {
      cancel,
      emitter,
    } as unknown as Task;

    try {
      attachTaskErrorHandler(task, onError);
      emitter.emit("error", { reason: "task failed" });

      expect(onError).toHaveBeenCalledWith({ reason: "task failed" });
      expect(errorSpy).toHaveBeenCalledWith(
        '[CLI] Failed to cancel task after error: {"reason":"cancel failed"}'
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("logs when task emitter is unavailable", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      attachTaskErrorHandler(
        {
          cancel: jest.fn(),
          emitter: undefined,
        } as unknown as Task,
        jest.fn()
      );

      expect(errorSpy).toHaveBeenCalledWith(
        "[CLI] Cannot attach task error handler: task emitter is unavailable"
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("logs when task emitter getter throws during attachment", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const task = new Proxy(
      {
        cancel: jest.fn(),
      },
      {
        get: (target, prop, receiver) => {
          if (prop === "emitter") {
            throw new Error("emitter trap");
          }
          return Reflect.get(target, prop, receiver);
        },
      }
    ) as unknown as Task;
    try {
      attachTaskErrorHandler(task, jest.fn());

      expect(errorSpy).toHaveBeenCalledWith(
        "[CLI] Failed to access task emitter: emitter trap"
      );
      expect(errorSpy).toHaveBeenCalledWith(
        "[CLI] Cannot attach task error handler: task emitter is unavailable"
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("logs when addListener registration throws", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const task = {
      cancel: jest.fn(),
      emitter: {
        addListener: () => {
          throw { reason: "listener failed" };
        },
      },
    } as unknown as Task;
    try {
      attachTaskErrorHandler(task, jest.fn());

      expect(errorSpy).toHaveBeenCalledWith(
        '[CLI] Failed to attach task error listener: {"reason":"listener failed"}'
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("sanitizes and truncates oversized listener attachment diagnostics", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const task = {
      cancel: jest.fn(),
      emitter: {
        addListener: () => {
          throw new Error(`listener\u0000\n${"x".repeat(10_000)}`);
        },
      },
    } as unknown as Task;
    try {
      attachTaskErrorHandler(task, jest.fn());
      const message = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes("Failed to attach task error listener"));
      expect(message).toBeDefined();
      expect(message).toContain("[truncated");
      expect(message).not.toContain("\u0000");
      expect(message).not.toContain("\n");
      expect(message?.length ?? 0).toBeLessThan(2_500);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
