import type {
  CDPClient,
  CDPSession,
  CDPTargetDescriptor,
} from "@/cdp/types";
import type { CDPSession as PlaywrightSession, Frame, Page } from "playwright-core";

class PlaywrightSessionAdapter implements CDPSession {
  readonly raw: PlaywrightSession;

  constructor(
    private readonly session: PlaywrightSession,
    private readonly release: (adapter: PlaywrightSessionAdapter) => void
  ) {
    this.raw = session;
  }

  async send<T = any, P = Record<string, unknown>>(
    method: string,
    params?: P
  ): Promise<T> {
    const result = (this.session.send as PlaywrightSession["send"])(
      method as any,
      params as any
    );
    return result as Promise<T>;
  }

  on(event: string, handler: (...payload: any[]) => void): void {
    this.session.on(
      event as Parameters<PlaywrightSession["on"]>[0],
      handler as Parameters<PlaywrightSession["on"]>[1]
    );
  }

  off(event: string, handler: (...payload: any[]) => void): void {
    const off = (this.session as PlaywrightSession & {
      off?: PlaywrightSession["off"];
    }).off;
    if (off) {
      off.call(this.session, event as Parameters<PlaywrightSession["off"]>[0], handler as Parameters<PlaywrightSession["off"]>[1]);
    }
  }

  async detach(): Promise<void> {
    try {
      await this.session.detach();
    } finally {
      this.release(this);
    }
  }
}

class PlaywrightCDPClient implements CDPClient {
  private rootSessionPromise: Promise<CDPSession> | null = null;
  private rootSessionAdapter: CDPSession | null = null;
  private readonly trackedSessions = new Set<PlaywrightSessionAdapter>();

  constructor(private readonly page: Page) {}

  get rootSession(): CDPSession {
    if (!this.rootSessionAdapter) {
      throw new Error(
        "CDP root session not initialized yet. Call ensureRootSession() first."
      );
    }
    return this.rootSessionAdapter;
  }

  async init(): Promise<CDPSession> {
    if (!this.rootSessionPromise) {
      this.rootSessionPromise = (async () => {
        const session = await this.createSession({
          type: "page",
          page: this.page,
        });
        this.rootSessionAdapter = session;
        return session;
      })();
    }
    return this.rootSessionPromise;
  }

  async createSession(descriptor?: CDPTargetDescriptor): Promise<CDPSession> {
    const target = this.resolveTarget(descriptor);
    const session = await this.page.context().newCDPSession(target);
    const wrapped = new PlaywrightSessionAdapter(session, (adapter) =>
      this.trackedSessions.delete(adapter)
    );
    this.trackedSessions.add(wrapped);
    return wrapped;
  }

  async dispose(): Promise<void> {
    const detachPromises = Array.from(this.trackedSessions).map((session) =>
      session.detach().catch(() => {})
    );
    await Promise.all(detachPromises);
    this.trackedSessions.clear();
  }

  private resolveTarget(
    descriptor?: CDPTargetDescriptor
  ): Page | Frame {
    if (!descriptor) {
      return this.page;
    }
    if (descriptor.type === "frame" && descriptor.frame) {
      return descriptor.frame as Frame;
    }
    if (descriptor.type === "page" && descriptor.page) {
      return descriptor.page as Page;
    }
    return this.page;
  }
}

const clientCache = new WeakMap<Page, PlaywrightCDPClient>();

export async function getCDPClientForPage(page: Page): Promise<CDPClient> {
  let client = clientCache.get(page);
  if (!client) {
    client = new PlaywrightCDPClient(page);
    clientCache.set(page, client);
  }
  await client.init();
  return client;
}
