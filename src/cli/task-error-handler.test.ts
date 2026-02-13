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
});
