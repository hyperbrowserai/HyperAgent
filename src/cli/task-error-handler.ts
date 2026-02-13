import type { Task } from "@/types";

export type TaskErrorHandler = (error: unknown) => void;

export function attachTaskErrorHandler(
  task: Task,
  onError: TaskErrorHandler
): void {
  task.emitter.addListener("error", (error: unknown) => {
    task.cancel();
    onError(error);
  });
}
