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

  it("allows retrying shutdown after prior attempt settles", async () => {
    const closeAgent = jest
      .fn()
      .mockRejectedValueOnce(new Error("first failed"))
      .mockResolvedValueOnce(undefined);
    const agent = { closeAgent };

    const first = await closeAgentSafely(
      agent as unknown as Parameters<typeof closeAgentSafely>[0]
    );
    const second = await closeAgentSafely(
      agent as unknown as Parameters<typeof closeAgentSafely>[0]
    );

    expect(first).toEqual({ success: false, message: "first failed" });
    expect(second).toEqual({ success: true });
    expect(closeAgent).toHaveBeenCalledTimes(2);
  });

  it("returns readable error for invalid agent objects", async () => {
    await expect(closeAgentSafely(undefined)).resolves.toEqual({
      success: false,
      message: "Invalid agent instance: closeAgent() is unavailable.",
    });
    await expect(closeAgentSafely(42)).resolves.toEqual({
      success: false,
      message: "Invalid agent instance: closeAgent() is unavailable.",
    });
    await expect(closeAgentSafely({})).resolves.toEqual({
      success: false,
      message: "Invalid agent instance: closeAgent() is unavailable.",
    });
  });

  it("returns readable error when closeAgent getter throws", async () => {
    const agent = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "closeAgent") {
            throw new Error("close getter trap");
          }
          return undefined;
        },
      }
    );

    await expect(closeAgentSafely(agent)).resolves.toEqual({
      success: false,
      message:
        "Invalid agent instance: failed to access closeAgent() (close getter trap).",
    });
  });
});
