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
});
