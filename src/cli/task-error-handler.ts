import type { Task } from "@/types";
import { formatCliError } from "./format-cli-error";

export type TaskErrorHandler = (error: unknown) => void;

function safeReadTaskField(
  task: Task,
  field: "emitter" | "cancel"
): unknown {
  try {
    return (task as unknown as Record<string, unknown>)[field];
  } catch (error) {
    console.error(
      `[CLI] Failed to access task ${field}: ${formatCliError(error)}`
    );
    return undefined;
  }
}

export function attachTaskErrorHandler(
  task: Task,
  onError: TaskErrorHandler
): void {
  if (typeof onError !== "function") {
    console.error("[CLI] Cannot attach task error handler: onError must be a function");
    return;
  }

  const emitter = safeReadTaskField(task, "emitter");
  const addListener =
    emitter && typeof emitter === "object"
      ? (emitter as { addListener?: unknown }).addListener
      : undefined;
  if (typeof addListener !== "function") {
    console.error(
      "[CLI] Cannot attach task error handler: task emitter is unavailable"
    );
    return;
  }

  let hasHandledError = false;
  try {
    addListener.call(emitter, "error", (error: unknown) => {
      if (hasHandledError) {
        return;
      }
      hasHandledError = true;
      const cancel = safeReadTaskField(task, "cancel");
      if (typeof cancel === "function") {
        try {
          cancel.call(task);
        } catch (cancelError) {
          console.error(
            `[CLI] Failed to cancel task after error: ${formatCliError(cancelError)}`
          );
        }
      }
      try {
        onError(error);
      } catch (handlerError) {
        console.error(
          `[CLI] Task error handler failed: ${formatCliError(handlerError)}`
        );
      }
    });
  } catch (error) {
    console.error(
      `[CLI] Failed to attach task error listener: ${formatCliError(error)}`
    );
  }
}
