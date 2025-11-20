import { HyperAgentError, HyperAgentErrorContext } from "@/error";

export class HyperagentError extends HyperAgentError {
  constructor(
    message: string,
    statusCode?: number,
    context?: Omit<HyperAgentErrorContext, "statusCode" | "opType">
  ) {
    super(`[Hyperagent]: ${message}`, { ...context, statusCode });
    this.name = "HyperagentError";
  }
}
