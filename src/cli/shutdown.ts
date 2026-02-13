import { formatCliError } from "./format-cli-error";

type ClosableAgent = {
  closeAgent: () => Promise<void>;
};

const shutdownPromises = new WeakMap<
  ClosableAgent,
  Promise<{ success: true } | { success: false; message: string }>
>();

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" ||
    typeof value === "function"
  ) && value !== null;
}

function resolveCloseAgent(
  agent: unknown
): { closeAgent: () => Promise<void> } | { error: string } {
  if (!isObjectLike(agent)) {
    return {
      error: "Invalid agent instance: closeAgent() is unavailable.",
    };
  }
  let closeAgentValue: unknown;
  try {
    closeAgentValue = (agent as { closeAgent?: unknown }).closeAgent;
  } catch (error) {
    return {
      error: `Invalid agent instance: failed to access closeAgent() (${formatCliError(
        error
      )}).`,
    };
  }
  if (typeof closeAgentValue !== "function") {
    return {
      error: "Invalid agent instance: closeAgent() is unavailable.",
    };
  }
  return {
    closeAgent: closeAgentValue.bind(agent) as () => Promise<void>,
  };
}

export async function closeAgentSafely(
  agent: unknown
): Promise<{ success: true } | { success: false; message: string }> {
  const resolvedAgent = resolveCloseAgent(agent);
  if ("error" in resolvedAgent) {
    return {
      success: false,
      message: resolvedAgent.error,
    };
  }

  const trackedAgent = agent as ClosableAgent;
  const existing = shutdownPromises.get(trackedAgent);
  if (existing) {
    return existing;
  }

  const shutdownPromise = (async () => {
    try {
      await resolvedAgent.closeAgent();
      return { success: true } as const;
    } catch (error) {
      return {
        success: false as const,
        message: formatCliError(error),
      };
    }
  })().finally(() => {
    shutdownPromises.delete(trackedAgent);
  });

  shutdownPromises.set(trackedAgent, shutdownPromise);
  return shutdownPromise;
}
