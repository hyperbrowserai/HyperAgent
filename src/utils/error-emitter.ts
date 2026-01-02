import EventEmitter from "events";

type ErrorEvents = {
  /**
   * Emitted when a task encounters an error.
   * The error object includes an optional `taskId` property to identify which task failed.
   * Listeners should check `error.taskId` before acting to avoid cross-task interference.
   */
  error: (error: Error & { taskId?: string }) => void;
  /**
   * Emitted when a task completes successfully.
   * @param taskId - The ID of the completed task
   */
  complete: (taskId: string) => void;
  /**
   * Emitted when a task is cancelled (either externally or internally).
   * @param taskId - The ID of the cancelled task
   */
  cancelled: (taskId: string) => void;
};

/**
 * Event emitter for HyperAgent task lifecycle events.
 * 
 * Events:
 * - `error`: Emitted when a task fails. Error includes optional `taskId` property.
 * - `complete`: Emitted when a task completes successfully.
 * - `cancelled`: Emitted when a task is cancelled.
 * 
 * @example
 * ```typescript
 * const emitter = new ErrorEmitter();
 * emitter.on('error', (error) => {
 *   if (error.taskId === myTaskId) {
 *     // Handle error for specific task
 *   }
 * });
 * ```
 */
export class ErrorEmitter extends EventEmitter {
  override on<K extends keyof ErrorEvents>(
    event: K,
    listener: ErrorEvents[K]
  ): this {
    return super.on(event, listener);
  }

  override once<K extends keyof ErrorEvents>(
    event: K,
    listener: ErrorEvents[K]
  ): this {
    return super.once(event, listener);
  }

  override off<K extends keyof ErrorEvents>(
    event: K,
    listener: ErrorEvents[K]
  ): this {
    return super.off(event, listener);
  }

  override emit<K extends keyof ErrorEvents>(
    event: K,
    ...args: Parameters<ErrorEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  override addListener<K extends keyof ErrorEvents>(
    eventName: K,
    listener: (...args: Parameters<ErrorEvents[K]>) => void
  ): this {
    return super.addListener(eventName, listener);
  }
}
