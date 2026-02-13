import { HyperAgent } from "./agent";
import { TaskStatus } from "./types/agent/types";
import { HyperagentError, HyperagentTaskError } from "./agent/error";

export { TaskStatus, HyperAgent, HyperagentError, HyperagentTaskError };
export type {
  ActionCacheOutput,
  ActionCacheReplayResult,
  ActionCacheReplayStepResult,
  AgentActionDefinition,
  AgentTaskOutput,
  HyperAgentConfig,
  HyperPage,
  HyperVariable,
  MCPConfig,
  MCPServerConfig,
  PerformOptions,
  PerformTaskParams,
  RunFromActionCacheParams,
  Task,
  TaskOutput,
  TaskParams,
} from "./types";
export default HyperAgent;

// For CommonJS compatibility
if (typeof module !== "undefined" && module.exports) {
  module.exports = HyperAgent;
  module.exports.HyperAgent = HyperAgent;
  module.exports.TaskStatus = TaskStatus;
  module.exports.HyperagentError = HyperagentError;
  module.exports.HyperagentTaskError = HyperagentTaskError;
  module.exports.default = HyperAgent;
}
