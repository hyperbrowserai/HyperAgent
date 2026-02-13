import { handleCliFatalError } from "@/cli/error-reporting";

describe("handleCliFatalError", () => {
  it("logs formatted error and trace in debug mode", async () => {
    const logError = jest.fn();
    const logTrace = jest.fn();

    await handleCliFatalError({
      error: { reason: "boom" },
      debug: true,
      logError,
      logTrace,
    });

    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('{"reason":"boom"}')
    );
    expect(logTrace).toHaveBeenCalledWith({ reason: "boom" });
  });

  it("attempts to close agent and logs shutdown failure", async () => {
    const logShutdownError = jest.fn();
    const agent = {
      closeAgent: jest.fn().mockRejectedValue({ reason: "close failed" }),
    };

    await handleCliFatalError({
      error: new Error("task failed"),
      debug: false,
      agent,
      logError: jest.fn(),
      logShutdownError,
    });

    expect(agent.closeAgent).toHaveBeenCalledTimes(1);
    expect(logShutdownError).toHaveBeenCalledWith(
      'Error during shutdown: {"reason":"close failed"}'
    );
  });

  it("remains resilient when logger callbacks throw", async () => {
    const agent = {
      closeAgent: jest.fn().mockRejectedValue({ reason: "close failed" }),
    };

    await expect(
      handleCliFatalError({
        error: { reason: "boom" },
        debug: true,
        agent,
        logError: () => {
          throw new Error("log failed");
        },
        logTrace: () => {
          throw new Error("trace failed");
        },
        logShutdownError: () => {
          throw new Error("shutdown log failed");
        },
      })
    ).resolves.toBeUndefined();

    expect(agent.closeAgent).toHaveBeenCalledTimes(1);
  });
});
