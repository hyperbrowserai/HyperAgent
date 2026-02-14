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

  it("filters protocol-relative known ad domains", () => {
    expect(
      isAdOrTrackingFrame({
        url: "//securepubads.g.doubleclick.net/pagead/ads",
      })
    ).toBe(true);
  });

  it("filters known ad domains without explicit protocol", () => {
    expect(
      isAdOrTrackingFrame({
        url: "securepubads.g.doubleclick.net/pagead/ads",
      })
    ).toBe(true);
  });

  it("filters known ad domains with host:port urls missing explicit protocol", () => {
    expect(
      isAdOrTrackingFrame({
        url: "securepubads.g.doubleclick.net:443/pagead/ads",
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

  it("filters scheme-less host URLs when tracking query params are present", () => {
    expect(
      isAdOrTrackingFrame({
        url: "cdn.example.net/widget?prebid=1",
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

  it("matches host+path ad-domain rules on the correct hostname only", () => {
    expect(
      isAdOrTrackingFrame({
        url: "https://www.yahoo.com/pixel?event=view",
      })
    ).toBe(true);
  });

  it("does not match host+path ad-domain rules from unrelated host query text", () => {
    expect(
      isAdOrTrackingFrame({
        url: "https://example.com/redirect?next=https://yahoo.com/pixel",
      })
    ).toBe(false);
  });

  it("does not match host-based ad domains for path-only urls", () => {
    expect(
      isAdOrTrackingFrame({
        url: "/redirect/doubleclick.net/pagead/ads",
      })
    ).toBe(false);
  });

  it("does not treat path-only tracking query params as strong frame signal", () => {
    expect(
      isAdOrTrackingFrame({
        url: "/widget?prebid=1",
      })
    ).toBe(false);
  });
});
