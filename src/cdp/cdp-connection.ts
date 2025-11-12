import type { Protocol } from "devtools-protocol";
import WebSocket from "ws";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

type EventHandler = (params?: unknown) => void;

export class CdpConnection {
  private ws: WebSocket | null = null;
  private readonly inflight = new Map<number, PendingRequest>();
  private readonly eventHandlers = new Map<string, Set<EventHandler>>();
  private readonly sessions = new Map<string, CdpSession>();
  private nextId = 1;

  constructor(private readonly wsEndpoint: string) {}

  async connect(): Promise<void> {
    if (this.ws) return;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsEndpoint);
      ws.once("open", () => {
        this.ws = ws;
        ws.on("message", (data) => this.onMessage(data.toString()));
        ws.on("close", () => this.handleClose());
        ws.on("error", (err) => this.handleError(err));
        resolve();
      });
      ws.once("error", reject);
    });
  }

  async close(): Promise<void> {
    if (!this.ws) return;
    await new Promise<void>((resolve) => {
      this.ws!.once("close", () => resolve());
      this.ws!.close();
    });
    this.ws = null;
    this.inflight.clear();
    this.sessions.clear();
    this.eventHandlers.clear();
  }

  async send<T = unknown>(
    method: string,
    params?: object,
    sessionId?: string
  ): Promise<T> {
    await this.connect();
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method };
    if (params) payload.params = params;
    if (sessionId) payload.sessionId = sessionId;

    const promise = new Promise<T>((resolve, reject) => {
      this.inflight.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });

    this.ws!.send(JSON.stringify(payload));
    return promise;
  }

  on(event: string, handler: EventHandler): void {
    const set = this.eventHandlers.get(event) ?? new Set<EventHandler>();
    set.add(handler);
    this.eventHandlers.set(event, set);
  }

  off(event: string, handler: EventHandler): void {
    const set = this.eventHandlers.get(event);
    if (!set) return;
    set.delete(handler);
  }

  getSession(sessionId: string): CdpSession {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = new CdpSession(this, sessionId);
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  get rootSession(): CdpSession {
    return this.getSession("root");
  }

  private onMessage(raw: string): void {
    const msg = JSON.parse(raw) as Record<string, unknown>;

    if ("id" in msg && typeof msg.id === "number") {
      const pending = this.inflight.get(msg.id);
      if (!pending) return;
      this.inflight.delete(msg.id);
      if (
        "error" in msg &&
        msg.error &&
        typeof msg.error === "object" &&
        msg.error !== null
      ) {
        const errorObj = msg.error as { code?: number; message?: string };
        pending.reject(
          new Error(
            `CDP error ${errorObj.code ?? ""}: ${errorObj.message ?? ""}`
          )
        );
      } else {
        pending.resolve(msg.result as unknown);
      }
      return;
    }

    if ("method" in msg && typeof msg.method === "string") {
      const method = msg.method;
      const params = msg.params;
      const handlers = this.eventHandlers.get(method);
      if (handlers) {
        for (const handler of handlers) {
          handler(params);
        }
      }

      if ("sessionId" in msg && typeof msg.sessionId === "string") {
        const session = this.sessions.get(msg.sessionId);
        session?.dispatch(method, params);
      }
    }
  }

  private handleClose(): void {
    this.ws = null;
    for (const pending of this.inflight.values()) {
      pending.reject(new Error("CDP connection closed"));
    }
    this.inflight.clear();
  }

  private handleError(error: Error): void {
    for (const pending of this.inflight.values()) {
      pending.reject(error);
    }
    this.inflight.clear();
  }
}

export class CdpSession {
  private readonly eventHandlers = new Map<string, Set<EventHandler>>();

  constructor(
    private readonly connection: CdpConnection,
    readonly id: string
  ) {}

  async send<T = unknown>(method: string, params?: object): Promise<T> {
    const sessionId = this.id === "root" ? undefined : this.id;
    return this.connection.send<T>(method, params, sessionId);
  }

  on(event: string, handler: EventHandler): void {
    const set = this.eventHandlers.get(event) ?? new Set<EventHandler>();
    set.add(handler);
    this.eventHandlers.set(event, set);
  }

  off(event: string, handler: EventHandler): void {
    const set = this.eventHandlers.get(event);
    if (!set) return;
    set.delete(handler);
  }

  dispatch(event: string, params?: unknown): void {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      handler(params);
    }
  }
}
