import { formatCliError } from "./format-cli-error";

type ClosableAgent = {
  closeAgent: () => Promise<void>;
};

const shutdownPromises = new WeakMap<
  ClosableAgent,
  Promise<{ success: true } | { success: false; message: string }>
>();

export async function closeAgentSafely(
  agent: ClosableAgent
): Promise<{ success: true } | { success: false; message: string }> {
  const existing = shutdownPromises.get(agent);
  if (existing) {
    return existing;
  }

  const shutdownPromise = (async () => {
    try {
      await agent.closeAgent();
      return { success: true } as const;
    } catch (error) {
      return {
        success: false as const,
        message: formatCliError(error),
      };
    }
  })().finally(() => {
    shutdownPromises.delete(agent);
  });

  shutdownPromises.set(agent, shutdownPromise);
  return shutdownPromise;
}
