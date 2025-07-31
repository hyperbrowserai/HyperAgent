import { HyperAgent } from "./agent";
import { TaskStatus } from "./types/agent/types";
import { HyperbrowserProvider, LocalBrowserProvider, CDPBrowserProvider, CDPBrowserConfig } from "./browser-providers";

export { TaskStatus, HyperAgent, HyperbrowserProvider, LocalBrowserProvider, CDPBrowserProvider, CDPBrowserConfig };
export default HyperAgent;

// For CommonJS compatibility
if (typeof module !== "undefined" && module.exports) {
  module.exports = HyperAgent;
  module.exports.HyperAgent = HyperAgent;
  module.exports.TaskStatus = TaskStatus;
  module.exports.HyperbrowserProvider = HyperbrowserProvider;
  module.exports.LocalBrowserProvider = LocalBrowserProvider;
  module.exports.CDPBrowserProvider = CDPBrowserProvider;
  module.exports.default = HyperAgent;
}
