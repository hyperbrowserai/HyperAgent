import { chromium } from "playwright-core";

import { LocalBrowserProvider } from "@/browser-providers/local";

jest.mock("playwright-core", () => ({
  chromium: {
    launch: jest.fn(),
  },
}));

describe("LocalBrowserProvider lifecycle hardening", () => {
  const launch = jest.mocked(chromium.launch);

  beforeEach(() => {
    jest.clearAllMocks();
    launch.mockReset();
  });

  it("surfaces readable launch failures", async () => {
    launch.mockRejectedValue(new Error("launch trap"));
    const provider = new LocalBrowserProvider();

    await expect(provider.start()).rejects.toThrow(
      "Failed to launch local browser: launch trap"
    );
  });

  it("truncates oversized launch diagnostics", async () => {
    launch.mockRejectedValue(new Error("x".repeat(2_000)));
    const provider = new LocalBrowserProvider();

    await expect(provider.start()).rejects.toThrow(/\[truncated/);
  });

  it("rejects invalid launch payloads", async () => {
    launch.mockResolvedValue("invalid-browser" as never);
    const provider = new LocalBrowserProvider();

    await expect(provider.start()).rejects.toThrow(
      "Local browser launch returned an invalid browser"
    );
  });

  it("clears session even when close fails", async () => {
    const provider = new LocalBrowserProvider();
    provider.session = {
      close: async () => {
        throw new Error("close trap");
      },
    } as never;

    await expect(provider.close()).rejects.toThrow(
      "Failed to close local browser session: close trap"
    );
    expect(provider.getSession()).toBeNull();
  });

  it("truncates oversized close diagnostics", async () => {
    const provider = new LocalBrowserProvider();
    provider.session = {
      close: async () => {
        throw new Error("x".repeat(2_000));
      },
    } as never;

    await expect(provider.close()).rejects.toThrow(/\[truncated/);
    expect(provider.getSession()).toBeNull();
  });

  it("adds anti-automation launch args by default", async () => {
    launch.mockResolvedValue({
      close: async () => undefined,
    } as never);
    const provider = new LocalBrowserProvider({
      args: ["--foo"],
    });

    await provider.start();

    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["--disable-blink-features=AutomationControlled", "--foo"],
      })
    );
  });
});
