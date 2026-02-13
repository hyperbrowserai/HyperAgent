export class HyperagentError extends Error {
  constructor(
    message: string,
    public statusCode?: number
  ) {
    super(`[Hyperagent]: ${message}`);
    this.name = "HyperagentError";
  }
}

export class HyperagentTaskError extends HyperagentError {
  public readonly taskId: string;
  public readonly cause: Error;

  constructor(taskId: string, cause: Error) {
    super(`Task ${taskId} failed: ${cause.message}`, 500);
    this.name = "HyperagentTaskError";
    this.taskId = taskId;
    this.cause = cause;
  }
}
