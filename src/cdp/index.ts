/**
 * CDP (Chrome DevTools Protocol) Module
 *
 * This module provides low-level CDP connection management without Playwright dependency.
 */

export {
  CDPConnectionManager,
  type LaunchLocalOptions,
  type CDPSession,
  type CDPTarget,
  type ConnectionStatus,
  type CDPConnectionManagerEvents,
} from "./connection-manager";

import { CDPConnectionManager } from "./connection-manager";
export default CDPConnectionManager;
