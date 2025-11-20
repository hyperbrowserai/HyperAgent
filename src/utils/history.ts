import { AgentHistoryEntry } from "@/types/history";

export class AgentHistory {
  private entries: AgentHistoryEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries = 200) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  public add(entry: AgentHistoryEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  public snapshot(): AgentHistoryEntry[] {
    return [...this.entries];
  }

  public clear(): void {
    this.entries = [];
  }

  public setLimit(limit: number): void {
    this.maxEntries = Math.max(1, limit);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }
}
