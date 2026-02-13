import type { Task } from "@/types";
import { formatUnknownError } from "@/utils";

export type TaskErrorHandler = (error: unknown) => void;

export function attachTaskErrorHandler(
  task: Task,
  onError: TaskErrorHandler
): void {
  let hasHandledError = false;
  task.emitter.addListener("error", (error: unknown) => {
    if (hasHandledError) {
      return;
    }
    hasHandledError = true;
    try {
      task.cancel();
    } catch (cancelError) {
      console.error(
        `[CLI] Failed to cancel task after error: ${formatUnknownError(cancelError)}`
      );
    }
    try {
      onError(error);
    } catch (handlerError) {
      console.error(
        `[CLI] Task error handler failed: ${formatUnknownError(handlerError)}`
      );
    }
  });
}
