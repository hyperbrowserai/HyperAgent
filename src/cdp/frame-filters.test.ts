import { isAdOrTrackingFrame } from "@/cdp/frame-filters";

describe("isAdOrTrackingFrame", () => {
  it("keeps about:blank frames to avoid false positives", () => {
    expect(
      isAdOrTrackingFrame({
        url: "about:blank",
      })
    ).toBe(false);
  });

  it("does not filter legitimate frames with a single weak keyword signal", () => {
    expect(
      isAdOrTrackingFrame({
        url: "https://example.com/sync-settings",
        name: "account sync settings",
      })
    ).toBe(false);
  });

  it("filters known ad domains immediately", () => {
    expect(
      isAdOrTrackingFrame({
        url: "https://securepubads.g.doubleclick.net/pagead/ads",
      })
    ).toBe(true);
  });

  it("filters obvious pixel-style tracking frames", () => {
    expect(
      isAdOrTrackingFrame({
        url: "https://tracker.example.com/pixel.gif?event=impression",
        name: "tracking pixel (1x1)",
      })
    ).toBe(true);
  });

  it("filters combined suspicious signals", () => {
    expect(
      isAdOrTrackingFrame({
        url: "https://cdn.example.net/widget/sync?prebid=1",
      })
    ).toBe(true);
  });
});
