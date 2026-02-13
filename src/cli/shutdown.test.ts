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
});
