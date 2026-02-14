/**
 * Utilities for filtering ad and tracking frames
 * Prevents non-interactive ad iframes from polluting the frame graph
 */

export interface FrameFilterContext {
  url: string;
  name?: string;
  parentUrl?: string;
}

interface FrameRiskSignal {
  name: string;
  weight: number;
  matched: boolean;
  strong?: boolean;
}

interface AdDomainRule {
  host: string;
  path?: string;
}

const PIXEL_PATTERNS = [/\(1×1\)/i, /\(1x1\)/i];

const SUSPICIOUS_PATTERNS = [
  /pixel/i,
  /user-sync/i,
  /cookie-sync/i,
  /usersync/i,
  /ecm3/i,
  /dcm/i,
  /safeframe/i,
  /topics\s+frame/i,
];

const TRACKING_EXTENSIONS = [
  ".gif",
  ".ashx",
  ".png?",
  "/pixel",
  "/usersync",
];

const AD_DOMAINS = [
  // Google ad networks
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "google-analytics.com",
  "googletagmanager.com",
  "googletagservices.com",
  "imasdk.googleapis.com",
  // Yahoo/Verizon Media
  "ybp.yahoo.com",
  "yahoo.com/pixel",
  // Major ad exchanges
  "adnxs.com",
  "rubiconproject.com",
  "pubmatic.com",
  "openx.net",
  "advertising.com",
  "contextweb.com",
  "casalemedia.com",
  // Retargeting/programmatic
  "criteo.com",
  "criteo.net",
  "bidswitch.net",
  // Analytics/tracking
  "quantserve.com",
  "scorecardresearch.com",
  "moatads.com",
  "adsafeprotected.com",
  "chartbeat.com",
  // Content recommendation (often ads)
  "outbrain.com",
  "taboola.com",
  "zemanta.com",
  // Other common ad networks
  "openwebmedia.org",
  "turn.com",
  "amazon-adsystem.com",
];

const AD_DOMAIN_RULES: AdDomainRule[] = AD_DOMAINS.map((entry) => {
  const [hostPart, ...pathParts] = entry.toLowerCase().split("/");
  const normalizedHost = hostPart?.trim() ?? "";
  const normalizedPath = pathParts.join("/").trim();
  return normalizedPath.length > 0
    ? { host: normalizedHost, path: `/${normalizedPath}` }
    : { host: normalizedHost };
});

const TRACKING_PARAMS = [
  "correlator=",
  "google_push=",
  "gdfp_req=",
  "prebid",
  "pubads",
];

const MIN_FILTER_SCORE = 2;

const HAS_PROTOCOL_PATTERN = /^[a-z][a-z0-9+\-.]*:/i;

function normalizeUrlForParsing(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (trimmed.startsWith("//")) {
    return `https:${trimmed}`;
  }
  if (HAS_PROTOCOL_PATTERN.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith("/")) {
    return "";
  }
  return `https://${trimmed}`;
}

function safeParseUrl(value: string | undefined): URL | null {
  if (!value) {
    return null;
  }
  const normalized = normalizeUrlForParsing(value);
  if (normalized.length === 0) {
    return null;
  }
  try {
    return new URL(normalized);
  } catch {
    return null;
  }
}

function safeGetHostname(value: string | undefined): string | null {
  const parsed = safeParseUrl(value);
  if (!parsed) {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  return hostname.length > 0 ? hostname : null;
}

function isSameSiteFrame(url: string, parentUrl: string | undefined): boolean {
  const hostname = safeGetHostname(url);
  const parentHostname = safeGetHostname(parentUrl);
  if (!hostname || !parentHostname) {
    return false;
  }
  return (
    hostname === parentHostname ||
    hostname.endsWith(`.${parentHostname}`) ||
    parentHostname.endsWith(`.${hostname}`)
  );
}

function matchesKnownAdDomain(url: string): boolean {
  const parsedUrl = safeParseUrl(url);
  if (!parsedUrl) {
    return false;
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const pathAndQuery = `${parsedUrl.pathname}${parsedUrl.search}`.toLowerCase();

  return AD_DOMAIN_RULES.some((rule) => {
    if (!rule.host) {
      return false;
    }
    const hostMatches =
      hostname === rule.host || hostname.endsWith(`.${rule.host}`);
    if (!hostMatches) {
      return false;
    }
    if (!rule.path) {
      return true;
    }
    return pathAndQuery.includes(rule.path);
  });
}

/**
 * Check if a frame is likely an ad or tracking iframe
 *
 * Heuristic model:
 * - Assign weighted signals for ad/tracking traits
 * - Filter only when score meets threshold
 * - Prevent single weak indicators (e.g. generic "sync" in URL) from dropping legitimate frames
 */
export function isAdOrTrackingFrame(context: FrameFilterContext): boolean {
  const { url, name, parentUrl } = context;
  const urlLower = url.toLowerCase();
  const nameLower = (name || "").toLowerCase();
  let normalizedPathSignalText = urlLower;
  let normalizedQuerySignalText = "";
  const parsedUrl = safeParseUrl(urlLower);
  if (parsedUrl) {
    normalizedPathSignalText = `${parsedUrl.hostname}${parsedUrl.pathname}`;
    normalizedQuerySignalText = parsedUrl.search;
  }

  // Allow empty/about:blank frames. They are often bootstrapped to real apps post-load.
  if (!url || urlLower === "about:blank") {
    return false;
  }

  const signals: FrameRiskSignal[] = [
    {
      name: "pixel-pattern",
      weight: 2,
      strong: true,
      matched: PIXEL_PATTERNS.some(
        (pattern) =>
          pattern.test(normalizedPathSignalText) || pattern.test(nameLower)
      ),
    },
    {
      name: "suspicious-keyword",
      weight: 1,
      matched: SUSPICIOUS_PATTERNS.some(
        (pattern) =>
          pattern.test(normalizedPathSignalText) || pattern.test(nameLower)
      ),
    },
    {
      name: "tracking-extension",
      weight: 1,
      matched: TRACKING_EXTENSIONS.some((ext) =>
        normalizedPathSignalText.includes(ext)
      ),
    },
    {
      name: "known-ad-domain",
      weight: 2,
      strong: true,
      matched: matchesKnownAdDomain(urlLower),
    },
    {
      name: "tracking-query-param",
      weight: 2,
      strong: true,
      matched: TRACKING_PARAMS.some(
        (param) =>
          normalizedQuerySignalText.includes(param) || urlLower.includes(param)
      ),
    },
    {
      name: "data-uri",
      weight: 2,
      strong: true,
      matched: urlLower.startsWith("data:"),
    },
  ];

  const riskScore = signals.reduce(
    (score, signal) => score + (signal.matched ? signal.weight : 0),
    0
  );

  if (riskScore < MIN_FILTER_SCORE) {
    return false;
  }

  const hasStrongSignal = signals.some(
    (signal) => signal.matched && signal.strong === true
  );
  if (!hasStrongSignal && isSameSiteFrame(url, parentUrl)) {
    return false;
  }

  return true;
}

