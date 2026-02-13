import { retry } from "@/utils/retry";

jest.mock("@/utils/sleep", () => ({
  sleep: jest.fn().mockResolvedValue(undefined),
}));

const { sleep } = jest.requireMock("@/utils/sleep") as {
  sleep: jest.Mock;
};

describe("retry", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses default retry count when provided retry count is invalid", async () => {
    const func = jest
      .fn()
      .mockRejectedValueOnce(new Error("one"))
      .mockRejectedValueOnce(new Error("two"))
      .mockResolvedValue("ok");

    const result = await retry({
      func,
      params: { retryCount: 0 },
    });

    expect(result).toBe("ok");
    expect(func).toHaveBeenCalledTimes(3);
  });

  it("uses default retry count when retry params omit retryCount", async () => {
    const func = jest
      .fn()
      .mockRejectedValueOnce(new Error("one"))
      .mockRejectedValueOnce(new Error("two"))
      .mockResolvedValue("ok");

    const result = await retry({
      func,
      params: {},
    });

    expect(result).toBe("ok");
    expect(func).toHaveBeenCalledTimes(3);
  });

  it("caps retry count to prevent unbounded retry loops", async () => {
    const func = jest.fn().mockRejectedValue(new Error("always fails"));

    await expect(
      retry({
        func,
        params: { retryCount: 1000 },
      })
    ).rejects.toThrow("always fails");

    expect(func).toHaveBeenCalledTimes(10);
  });

  it("caps exponential backoff delay to bounded maximum", async () => {
    const func = jest.fn().mockRejectedValue(new Error("always fails"));

    await expect(
      retry({
        func,
        params: { retryCount: 10 },
      })
    ).rejects.toThrow("always fails");

    expect(sleep).toHaveBeenCalledTimes(9);
    const sleepDelays = sleep.mock.calls.map((call) => call[0] as number);
    expect(Math.max(...sleepDelays)).toBe(10000);
    expect(sleepDelays.some((delay) => delay > 10000)).toBe(false);
  });

  it("does not sleep after the final failed attempt", async () => {
    const func = jest.fn().mockRejectedValue(new Error("always fails"));

    await expect(
      retry({
        func,
        params: { retryCount: 2 },
      })
    ).rejects.toThrow("always fails");

    expect(func).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("reports attempt numbers in onError callback", async () => {
    const onError = jest.fn();
    const func = jest
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockResolvedValue("ok");

    const result = await retry({
      func,
      params: { retryCount: 3 },
      onError,
    });

    expect(result).toBe("ok");
    expect(onError).toHaveBeenCalledWith(
      "Retry Attempt 1/3",
      expect.any(Error)
    );
  });

  it("continues retrying when onError callback throws", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const onError = jest.fn(() => {
      throw { reason: "onError crashed" };
    });
    const func = jest
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockResolvedValue("ok");

    try {
      const result = await retry({
        func,
        params: { retryCount: 2 },
        onError,
      });

      expect(result).toBe("ok");
      expect(warnSpy).toHaveBeenCalledWith(
        '[retry] onError handler failed: {"reason":"onError crashed"}'
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("continues retrying when sleep throws", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    sleep.mockRejectedValueOnce({ reason: "sleep failed" }).mockResolvedValue(undefined);
    const func = jest
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockResolvedValue("ok");

    try {
      const result = await retry({
        func,
        params: { retryCount: 2 },
      });

      expect(result).toBe("ok");
      expect(func).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(
        '[retry] sleep failed: {"reason":"sleep failed"}'
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
