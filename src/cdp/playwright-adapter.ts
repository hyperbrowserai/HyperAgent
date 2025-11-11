import type {
  CDPClient,
  CDPSession,
  CDPTargetDescriptor,
} from "@/cdp/types";
import type { CDPSession as PlaywrightSession, Frame, Page } from "playwright-core";

class PlaywrightSessionAdapter implements CDPSession {
  readonly raw: PlaywrightSession;
  readonly id: string | null;

  constructor(
    private readonly session: PlaywrightSession,
    private readonly release: (adapter: PlaywrightSessionAdapter) => void
  ) {
    this.raw = session;
    this.id = extractSessionId(session);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async send<T = any>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    const result = (this.session.send as PlaywrightSession["send"])(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      method as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params as any
    );
    return result as Promise<T>;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (...payload: any[]) => void): void {
    this.session.on(
      event as Parameters<PlaywrightSession["on"]>[0],
      handler as Parameters<PlaywrightSession["on"]>[1]
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    } catch (error) {
      console.warn("[CDP][PlaywrightAdapter] Failed to detach session:", error);
    } finally {
      this.release(this);
    }
  }
}

function extractSessionId(session: PlaywrightSession): string | null {
  const candidate = session as PlaywrightSession & {
    _sessionId?: string;
    _guid?: string;
  };
  return candidate._sessionId ?? candidate._guid ?? null;
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
      session.detach().catch((error) => {
        console.warn(
          "[CDP][PlaywrightAdapter] Failed to detach cached session:",
          error
        );
      })
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

const clientCache = new Map<Page, PlaywrightCDPClient>();
const pendingClients = new Map<Page, Promise<CDPClient>>();

export async function getCDPClientForPage(page: Page): Promise<CDPClient> {
  // Return already initialized client
  const existing = clientCache.get(page);
  if (existing) {
    return existing;
  }

  // Return pending initialization promise to avoid race conditions
  const pending = pendingClients.get(page);
  if (pending) {
    return pending;
  }

  // Create new client with initialization
  const initPromise = (async () => {
    const client = new PlaywrightCDPClient(page);
    await client.init();
    clientCache.set(page, client);
    pendingClients.delete(page);
    page.once("close", () => {
      disposeCDPClientForPage(page).catch(() => {});
    });
    return client;
  })();

  pendingClients.set(page, initPromise);
  return initPromise;
}

export async function disposeCDPClientForPage(page: Page): Promise<void> {
  const client = clientCache.get(page);
  clientCache.delete(page);
  pendingClients.delete(page);
  if (!client) return;
  await client.dispose().catch((error) => {
    console.warn(
      "[CDP][PlaywrightAdapter] Failed to dispose client for page:",
      error
    );
  });
}

export async function disposeAllCDPClients(): Promise<void> {
  const disposals = Array.from(clientCache.entries()).map(
    async ([page, client]) => {
      clientCache.delete(page);
      pendingClients.delete(page);
      await client.dispose().catch((error) => {
        console.warn(
          "[CDP][PlaywrightAdapter] Failed to dispose cached client:",
          error
        );
      });
    }
  );
  await Promise.all(disposals);
  pendingClients.clear();
}
