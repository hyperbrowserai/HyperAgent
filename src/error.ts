import { OperationType } from "@/types/metrics";

export interface HyperAgentErrorContext {
  opType?: OperationType;
  url?: string;
  instruction?: string;
  selector?: string;
  step?: string;
  cause?: unknown;
  statusCode?: number;
}

export class HyperAgentError extends Error {
  public readonly opType?: OperationType;
  public readonly url?: string;
  public readonly instruction?: string;
  public readonly selector?: string;
  public readonly step?: string;
  public readonly cause?: unknown;
  public readonly statusCode?: number;

  constructor(message: string, context: HyperAgentErrorContext = {}) {
    super(message);
    this.name = "HyperAgentError";
    this.opType = context.opType;
    this.url = context.url;
    this.instruction = context.instruction;
    this.selector = context.selector;
    this.step = context.step;
    this.cause = context.cause;
    this.statusCode = context.statusCode;
  }
}

export class HyperAgentActError extends HyperAgentError {
  constructor(message: string, context: Omit<HyperAgentErrorContext, "opType"> = {}) {
    super(message, { ...context, opType: "act" });
    this.name = "HyperAgentActError";
  }
}

export class HyperAgentExtractError extends HyperAgentError {
  constructor(message: string, context: Omit<HyperAgentErrorContext, "opType"> = {}) {
    super(message, { ...context, opType: "extract" });
    this.name = "HyperAgentExtractError";
  }
}

export class HyperAgentObserveError extends HyperAgentError {
  constructor(message: string, context: Omit<HyperAgentErrorContext, "opType"> = {}) {
    super(message, { ...context, opType: "observe" });
    this.name = "HyperAgentObserveError";
  }
}
