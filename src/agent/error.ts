import { HyperAgentError, HyperAgentErrorContext } from "@/error";

// Legacy alias kept for compatibility; normalized name to reduce confusion
export class HyperagentError extends HyperAgentError {
  constructor(
    message: string,
    statusCode?: number,
    context?: Omit<HyperAgentErrorContext, "statusCode" | "opType">
  ) {
    super(message, { ...context, statusCode });
    this.name = "HyperAgentError";
  }
}
