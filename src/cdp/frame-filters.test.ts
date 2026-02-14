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

  it("keeps same-site frames when only weak ad signals are present", () => {
    expect(
      isAdOrTrackingFrame({
        url: "https://app.example.com/assets/pixel.png?theme=dark",
        parentUrl: "https://app.example.com/dashboard",
      })
    ).toBe(false);
  });

  it("still filters same-site frames when strong tracking signals exist", () => {
    expect(
      isAdOrTrackingFrame({
        url: "https://app.example.com/widget/frame?prebid=1",
        parentUrl: "https://app.example.com/dashboard",
      })
    ).toBe(true);
  });

  it("does not treat ad-domain tokens in path as known ad host matches", () => {
    expect(
      isAdOrTrackingFrame({
        url: "https://docs.example.com/reference/doubleclick.net-integration",
        parentUrl: "https://docs.example.com/guide",
      })
    ).toBe(false);
  });

  it("matches known ad domains by subdomain suffix", () => {
    expect(
      isAdOrTrackingFrame({
        url: "https://ads.securepubads.g.doubleclick.net/pagead/ads",
      })
    ).toBe(true);
  });
});
