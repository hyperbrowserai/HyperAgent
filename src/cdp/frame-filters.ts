/**
 * Utilities for filtering ad and tracking frames
 * Prevents non-interactive ad iframes from polluting the frame graph
 */

export interface FrameFilterContext {
  url: string;
  name?: string;
  parentUrl?: string;
}

/**
 * Check if a frame is likely an ad or tracking iframe
 * 
 * Detection criteria:
 * 1. Tiny pixel frames (1x1) - common for tracking pixels
 * 2. Known ad/tracking keywords in URL or name
 * 3. Known ad network domains
 * 4. Common tracking file extensions
 */
export function isAdOrTrackingFrame(context: FrameFilterContext): boolean {
  const { url, name } = context;
  const urlLower = url.toLowerCase();
  const nameLower = (name || "").toLowerCase();
  
  // 1. Empty or about:blank frames (except named ones which might be legitimate)
  if (!url || url === "about:blank") {
    return !name; // Keep if it has a name, filter if anonymous
  }
  
  // 2. Pixel/sync frame patterns in title/name
  const suspiciousPatterns = [
    /\(1×1\)/i,
    /\(1x1\)/i,
    /pixel/i,
    /sync/i,
    /user-sync/i,
    /cookie-sync/i,
    /usersync/i,
    /match/i,
    /ecm3/i,
    /dcm/i,
    /safeframe/i,
    /topics\s+frame/i,
  ];
  
  if (suspiciousPatterns.some(pattern => 
    pattern.test(urlLower) || pattern.test(nameLower)
  )) {
    return true;
  }
  
  // 3. Tracking/ad file extensions
  const trackingExtensions = [
    '.gif',
    '.ashx',
    '.png?',
    '/pixel',
    '/sync',
    '/match',
    '/usersync',
  ];
  
  if (trackingExtensions.some(ext => urlLower.includes(ext))) {
    return true;
  }
  
  // 4. Known ad network domains
  const adDomains = [
    // Google ad networks
    'doubleclick.net',
    'googlesyndication.com',
    'googleadservices.com',
    'google-analytics.com',
    'googletagmanager.com',
    'googletagservices.com',
    'imasdk.googleapis.com',
    // Yahoo/Verizon Media
    'ybp.yahoo.com',
    'yahoo.com/pixel',
    // Major ad exchanges
    'adnxs.com',
    'rubiconproject.com',
    'pubmatic.com',
    'openx.net',
    'advertising.com',
    'contextweb.com',
    'casalemedia.com',
    // Retargeting/programmatic
    'criteo.com',
    'criteo.net',
    'bidswitch.net',
    // Analytics/tracking
    'quantserve.com',
    'scorecardresearch.com',
    'moatads.com',
    'adsafeprotected.com',
    'chartbeat.com',
    // Content recommendation (often ads)
    'outbrain.com',
    'taboola.com',
    'zemanta.com',
    // Other common ad networks
    'openwebmedia.org',
    'turn.com',
    'advertising.com',
    'amazon-adsystem.com',
  ];
  
  if (adDomains.some(domain => urlLower.includes(domain))) {
    return true;
  }
  
  // 5. Data URIs (often used for embedded ads)
  if (urlLower.startsWith('data:')) {
    return true;
  }
  
  // 6. Common tracking query parameters
  const trackingParams = [
    'correlator=',
    'google_push=',
    'gdfp_req=',
    'prebid',
    'pubads',
  ];
  
  if (trackingParams.some(param => urlLower.includes(param))) {
    return true;
  }
  
  return false;
}

