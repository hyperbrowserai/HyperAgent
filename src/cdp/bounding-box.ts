import type { CDPSession } from "@/cdp/types";
import type { Protocol } from "devtools-protocol";

// Track which domains have been enabled per session
const enabledDomains = new WeakMap<object, Set<string>>();

async function ensureDomainEnabled(
  session: CDPSession,
  domain: string
): Promise<void> {
  let enabled = enabledDomains.get(session as object);
  if (!enabled) {
    enabled = new Set();
    enabledDomains.set(session as object, enabled);
  }
  if (enabled.has(domain)) return;

  try {
    await session.send(`${domain}.enable`);
    enabled.add(domain);
  } catch (error) {
    console.warn(`[CDP][BoundingBox] Failed to enable ${domain} domain:`, error);
  }
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
}

interface BoundingBoxOptions {
  session: CDPSession;
  backendNodeId: number;
  xpath?: string;
  preferScript?: boolean;
}

async function getBoundingBoxFromScript(
  session: CDPSession,
  backendNodeId: number,
  xpath: string
): Promise<BoundingBox | null> {
  try {
    await ensureDomainEnabled(session, "Runtime");
    const payload = JSON.stringify({ [xpath]: backendNodeId });
    const expression = `(() => {
      if (typeof window.__hyperagent_collectBoundingBoxesByXPath !== "function") {
        return null;
      }
      const result = window.__hyperagent_collectBoundingBoxesByXPath(${payload});
      return result && result["${backendNodeId}"] ? result["${backendNodeId}"] : null;
    })()`;

    const response = await session.send<Protocol.Runtime.EvaluateResponse>(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
      }
    );

    const value = response.result?.value;
    if (!value || typeof value !== "object") {
      return null;
    }

    const { x, y, width, height, top, left, right, bottom } = value as Record<
      string,
      number
    >;

    if (
      [x, y, width, height, top, left, right, bottom].some(
        (n) => typeof n !== "number"
      )
    ) {
      return null;
    }

    return {
      x,
      y,
      width,
      height,
      top,
      left,
      right,
      bottom,
    };
  } catch {
    return null;
  }
}

async function getBoundingBoxFromQuads(
  session: CDPSession,
  backendNodeId: number
): Promise<BoundingBox | null> {
  try {
    await ensureDomainEnabled(session, "DOM");
    const response = await session.send<Protocol.DOM.GetContentQuadsResponse>(
      "DOM.getContentQuads",
      { backendNodeId }
    );

    const quad = response.quads?.[0];
    if (!quad) return null;

    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const left = Math.min(...xs);
    const right = Math.max(...xs);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);

    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      top,
      left,
      right,
      bottom,
    };
  } catch (error) {
    console.warn("[CDP][BoundingBox] Failed to get content quads:", error);
    return null;
  }
}

export async function getBoundingBox(
  options: BoundingBoxOptions
): Promise<BoundingBox | null> {
  const { session, backendNodeId, xpath, preferScript } = options;

  if (preferScript && xpath) {
    const scriptResult = await getBoundingBoxFromScript(
      session,
      backendNodeId,
      xpath
    );
    if (scriptResult) {
      return scriptResult;
    }
  }

  return getBoundingBoxFromQuads(session, backendNodeId);
}
