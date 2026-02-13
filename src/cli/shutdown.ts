import { formatCliError } from "./format-cli-error";

type ClosableAgent = {
  closeAgent: () => Promise<void>;
};

export async function closeAgentSafely(
  agent: ClosableAgent
): Promise<{ success: true } | { success: false; message: string }> {
  try {
    await agent.closeAgent();
    return { success: true };
  } catch (error) {
    return {
      success: false,
      message: formatCliError(error),
    };
  }
}
