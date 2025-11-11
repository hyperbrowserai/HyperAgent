import WebSocket, { RawData } from "ws";
import type { Protocol } from "devtools-protocol";
import type { CDPSession } from "@/cdp/types";

interface InflightEntry {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  params?: Record<string, unknown>;
  sessionId: string | null;
}

type EventHandler = (params: unknown) => void;

type RawMessage =
  | {
      id: number;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
      sessionId?: string;
    }
  | { method: string; params?: unknown; sessionId?: string };

class CdpSession implements CDPSession {
  private readonly handlers = new Map<string, Set<EventHandler>>();

  constructor(
    private readonly connection: CdpConnection,
    readonly id: string | null
  ) {}

  async send<T = any>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    return this.connection.sendCommand(method, params, this.id) as Promise<T>;
  }

  on(event: string, handler: EventHandler): void {
    const set = this.handlers.get(event) ?? new Set<EventHandler>();
    set.add(handler);
    this.handlers.set(event, set);
  }

  off(event: string, handler: EventHandler): void {
    const set = this.handlers.get(event);
    if (set) {
      set.delete(handler);
      if (set.size === 0) {
        this.handlers.delete(event);
      }
    }
  }

  emit(event: string, params: unknown): void {
    const handlers = this.handlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(params);
      } catch (error) {
        console.error(`[CdpSession] handler error for ${event}:`, error);
      }
    }
  }

  async detach(): Promise<void> {
    if (this.id) {
      try {
        await this.connection.sendCommand(
          "Target.detachFromTarget",
          { sessionId: this.id },
          null
        );
      } finally {
        this.connection.forgetSession(this.id);
      }
    } else {
      await this.connection.close();
    }
  }
}

export class CdpConnection {
  private ws: WebSocket;
  private nextId = 1;
  private readonly inflight = new Map<number, InflightEntry>();
  private readonly sessions = new Map<string, CdpSession>();
  private readonly transportCloseHandlers = new Set<(why: string) => void>();
  private readonly rootSession: CdpSession;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.rootSession = new CdpSession(this, null);
    this.setupSocket();
  }

  static async connect(wsUrl: string): Promise<CdpConnection> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err: Error) => reject(err));
    });
    return new CdpConnection(ws);
  }

  get root(): CDPSession {
    return this.rootSession;
  }

  onTransportClosed(handler: (why: string) => void): void {
    this.transportCloseHandlers.add(handler);
  }

  offTransportClosed(handler: (why: string) => void): void {
    this.transportCloseHandlers.delete(handler);
  }

  async attachToTarget(targetId: string): Promise<CDPSession> {
    const { sessionId } = (await this.sendCommand(
      "Target.attachToTarget",
      { targetId, flatten: true },
      null
    )) as { sessionId: string };

    return this.getOrCreateSession(sessionId);
  }

  async getTargets(): Promise<Protocol.Target.TargetInfo[]> {
    const result = (await this.sendCommand(
      "Target.getTargets",
      undefined,
      null
    )) as { targetInfos: Protocol.Target.TargetInfo[] };
    return result.targetInfos;
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }

  private setupSocket(): void {
    this.ws.on("message", (data: RawData) => this.onMessage(data));
    this.ws.on("close", (code: number, reason: Buffer) => {
      const why = `socket-close code=${code} reason=${String(reason || "")}`;
      this.handleTransportClosed(why);
    });
    this.ws.on("error", (error: Error) => {
      const why = `socket-error ${error?.message ?? String(error)}`;
      this.handleTransportClosed(why);
    });
  }

  private async onMessage(data: RawData): Promise<void> {
    let parsed: RawMessage;
    try {
      parsed = JSON.parse(data.toString());
    } catch (error) {
      console.error("[CdpConnection] Failed to parse CDP message", error);
      return;
    }

    if ("id" in parsed) {
      const entry = this.inflight.get(parsed.id);
      if (!entry) return;
      this.inflight.delete(parsed.id);

      if (parsed.error) {
        entry.reject(
          new Error(`${parsed.error.code} ${parsed.error.message}`)
        );
      } else {
        entry.resolve(parsed.result);
      }
      return;
    }

    this.dispatchEvent(parsed.method, parsed.params, parsed.sessionId);
  }

  private dispatchEvent(
    method: string,
    params: unknown,
    sessionId?: string
  ): void {
    if (method === "Target.attachedToTarget") {
      const evt = params as Protocol.Target.AttachedToTargetEvent;
      const session = this.getOrCreateSession(evt.sessionId);
      this.rootSession.emit(method, params);
      session.emit("Target.attachedToTarget", params);
      return;
    }

    if (method === "Target.detachedFromTarget") {
      const evt = params as Protocol.Target.DetachedFromTargetEvent;
      this.forgetSession(evt.sessionId);
      this.rootSession.emit(method, params);
      return;
    }

    const targetSession = sessionId
      ? this.sessions.get(sessionId)
      : this.rootSession;
    targetSession?.emit(method, params);
  }

  private getOrCreateSession(sessionId: string): CdpSession {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = new CdpSession(this, sessionId);
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  sendCommand(
    method: string,
    params?: Record<string, unknown>,
    sessionId: string | null = null
  ): Promise<unknown> {
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method };
    if (params) payload.params = params;
    if (sessionId) payload.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      this.inflight.set(id, {
        resolve,
        reject,
        method,
        params,
        sessionId,
      });
      this.ws.send(JSON.stringify(payload));
    });
  }

  forgetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private handleTransportClosed(reason: string): void {
    for (const entry of this.inflight.values()) {
      entry.reject(new Error(reason));
    }
    this.inflight.clear();
    for (const handler of this.transportCloseHandlers) {
      try {
        handler(reason);
      } catch (error) {
        console.error("[CdpConnection] transport close handler error", error);
      }
    }
  }
}

export default CdpConnection;
