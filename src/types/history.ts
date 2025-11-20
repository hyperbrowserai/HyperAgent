import { OperationType } from "./metrics";

export interface AgentHistoryEntry {
  id: string;
  ts: number;
  opType: OperationType;
  url?: string;
  instruction?: string;
  selector?: string;
  model?: string;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  cacheHit: boolean;
  error?: string;
  warning?: string;
}
