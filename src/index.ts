import { HyperAgent } from "./agent";
import {
  TaskStatus,
  ActionCacheOutput,
  ActionCacheEntry,
  ActionCacheReplayResult,
  TaskParams,
  PerformParams,
  TaskOutput,
  StructuredTaskOutput,
  AgentTaskOutput,
  Task,
  TaskHandle,
  HyperVariable,
  RunFromActionCacheParams,
  HyperPage,
} from "./types/agent/types";
import { HyperagentError } from "./agent/error";

export {
  HyperAgent,
  TaskStatus,
  ActionCacheOutput,
  ActionCacheEntry,
  ActionCacheReplayResult,
  TaskParams,
  PerformParams,
  TaskOutput,
  StructuredTaskOutput,
  AgentTaskOutput,
  Task,
  TaskHandle,
  HyperVariable,
  RunFromActionCacheParams,
  HyperPage,
  HyperagentError,
};
export default HyperAgent;

// For CommonJS compatibility
// Note: Only classes and enums (runtime values) can be exported via module.exports
// Type/interface exports are available via TypeScript's type system
if (typeof module !== "undefined" && module.exports) {
  module.exports = HyperAgent;
  module.exports.HyperAgent = HyperAgent;
  module.exports.TaskStatus = TaskStatus;
  module.exports.HyperagentError = HyperagentError;
  module.exports.default = HyperAgent;
}
