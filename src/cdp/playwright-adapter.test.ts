import type { CDPSession as PlaywrightSession, Page } from "playwright-core";
import {
  disposeAllCDPClients,
  disposeCDPClientForPage,
  getCDPClientForPage,
} from "@/cdp/playwright-adapter";

describe("playwright adapter error formatting", () => {
  afterEach(async () => {
    await disposeAllCDPClients();
    jest.restoreAllMocks();
  });

  it("formats non-Error session detach failures", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const session = {
      send: jest.fn().mockResolvedValue({}),
      on: jest.fn(),
      off: jest.fn(),
      detach: jest.fn().mockRejectedValue({ reason: "detach object failure" }),
    } as unknown as PlaywrightSession;
    const page = {
      context: () => ({
        newCDPSession: jest.fn().mockResolvedValue(session),
      }),
      once: jest.fn(),
    } as unknown as Page;

    await getCDPClientForPage(page);
    await disposeCDPClientForPage(page);

    expect(warnSpy).toHaveBeenCalledWith(
      '[CDP][PlaywrightAdapter] Failed to detach session: {"reason":"detach object failure"}'
    );
  });

  it("sanitizes and truncates oversized detach diagnostics", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const noisyFailure = `detach\u0000\n${"x".repeat(10_000)}`;
    const session = {
      send: jest.fn().mockResolvedValue({}),
      on: jest.fn(),
      off: jest.fn(),
      detach: jest.fn().mockRejectedValue(new Error(noisyFailure)),
    } as unknown as PlaywrightSession;
    const page = {
      context: () => ({
        newCDPSession: jest.fn().mockResolvedValue(session),
      }),
      once: jest.fn(),
    } as unknown as Page;

    await getCDPClientForPage(page);
    await disposeCDPClientForPage(page);

    const detachWarning = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes("Failed to detach session"));
    expect(detachWarning).toBeDefined();
    expect(detachWarning).toContain("[truncated");
    expect(detachWarning).not.toContain("\u0000");
    expect(detachWarning).not.toContain("\n");
    expect(detachWarning?.length ?? 0).toBeLessThan(700);
  });
});
