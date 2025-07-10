export class HyperagentError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
  ) {
    super(`[Hyperagent]: ${message}`);
    this.name = "HyperagentError";
  }
}
