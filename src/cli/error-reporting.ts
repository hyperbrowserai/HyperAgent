import chalk from "chalk";
import { formatCliError } from "./format-cli-error";
import { closeAgentSafely } from "./shutdown";

interface ClosableAgent {
  closeAgent: () => Promise<void>;
}

export async function handleCliFatalError(params: {
  error: unknown;
  debug: boolean;
  agent?: ClosableAgent;
  logError?: (message: string) => void;
  logTrace?: (...args: unknown[]) => void;
  logShutdownError?: (message: string) => void;
}): Promise<void> {
  const {
    error,
    debug,
    agent,
    logError = console.log,
    logTrace = console.trace,
    logShutdownError = console.error,
  } = params;

  try {
    logError(chalk.red(formatCliError(error)));
  } catch {
    // best-effort logging only
  }
  if (debug) {
    try {
      logTrace(error);
    } catch {
      // best-effort logging only
    }
  }

  if (!agent) {
    return;
  }

  const shutdown = await closeAgentSafely(agent);
  if (!shutdown.success) {
    try {
      logShutdownError(`Error during shutdown: ${shutdown.message}`);
    } catch {
      // best-effort logging only
    }
  }
}
