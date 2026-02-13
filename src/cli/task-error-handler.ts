import type { Task } from "@/types";
import { formatUnknownError } from "@/utils";

export type TaskErrorHandler = (error: unknown) => void;

export function attachTaskErrorHandler(
  task: Task,
  onError: TaskErrorHandler
): void {
  task.emitter.addListener("error", (error: unknown) => {
    task.cancel();
    try {
      onError(error);
    } catch (handlerError) {
      console.error(
        `[CLI] Task error handler failed: ${formatUnknownError(handlerError)}`
      );
    }
  });
}
