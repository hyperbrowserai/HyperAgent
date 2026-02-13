import { setRawModeIfSupported } from "@/cli/stdin-utils";

describe("setRawModeIfSupported", () => {
  it("does nothing when input is not a TTY", () => {
    const setRawMode = jest.fn();

    setRawModeIfSupported(true, {
      isTTY: false,
      setRawMode,
    });

    expect(setRawMode).not.toHaveBeenCalled();
  });

  it("does nothing when setRawMode is unavailable", () => {
    expect(() =>
      setRawModeIfSupported(true, {
        isTTY: true,
      })
    ).not.toThrow();
  });

  it("enables raw mode when supported", () => {
    const setRawMode = jest.fn();

    setRawModeIfSupported(true, {
      isTTY: true,
      setRawMode,
    });

    expect(setRawMode).toHaveBeenCalledWith(true);
  });

  it("logs warning instead of throwing when setRawMode fails", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const setRawMode = jest.fn(() => {
      throw { reason: "tty unavailable" };
    });

    try {
      expect(() =>
        setRawModeIfSupported(true, {
          isTTY: true,
          setRawMode,
        })
      ).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        '[CLI] Failed to set raw mode: {"reason":"tty unavailable"}'
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
