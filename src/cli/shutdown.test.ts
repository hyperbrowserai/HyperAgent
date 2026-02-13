import { closeAgentSafely } from "@/cli/shutdown";

describe("closeAgentSafely", () => {
  it("returns success when closeAgent resolves", async () => {
    const agent = {
      closeAgent: jest.fn().mockResolvedValue(undefined),
    };

    await expect(
      closeAgentSafely(agent as unknown as Parameters<typeof closeAgentSafely>[0])
    ).resolves.toEqual({ success: true });
  });

  it("returns formatted message when closeAgent rejects", async () => {
    const agent = {
      closeAgent: jest.fn().mockRejectedValue({ reason: "close failed" }),
    };

    await expect(
      closeAgentSafely(agent as unknown as Parameters<typeof closeAgentSafely>[0])
    ).resolves.toEqual({
      success: false,
      message: '{"reason":"close failed"}',
    });
  });

  it("reuses in-flight shutdown result for repeated calls", async () => {
    const closeAgent = jest.fn().mockResolvedValue(undefined);
    const agent = { closeAgent };

    const [first, second] = await Promise.all([
      closeAgentSafely(
        agent as unknown as Parameters<typeof closeAgentSafely>[0]
      ),
      closeAgentSafely(
        agent as unknown as Parameters<typeof closeAgentSafely>[0]
      ),
    ]);

    expect(first).toEqual({ success: true });
    expect(second).toEqual({ success: true });
    expect(closeAgent).toHaveBeenCalledTimes(1);
  });
});
