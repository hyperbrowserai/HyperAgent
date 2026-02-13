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
});
