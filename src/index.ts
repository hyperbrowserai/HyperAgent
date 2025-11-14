import { HyperAgent } from "./agent";
import { TaskStatus } from "./types/agent/types";

export { TaskStatus, HyperAgent };
export default HyperAgent;

// For CommonJS compatibility
if (typeof module !== "undefined" && module.exports) {
  module.exports = HyperAgent;
  module.exports.HyperAgent = HyperAgent;
  module.exports.TaskStatus = TaskStatus;
  module.exports.default = HyperAgent;
}
