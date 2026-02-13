export interface CDPSession {
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T>;
  on<TPayload extends unknown[]>(
    event: string,
    handler: (...payload: TPayload) => void
  ): void;
  off?<TPayload extends unknown[]>(
    event: string,
    handler: (...payload: TPayload) => void
  ): void;
  detach(): Promise<void>;
  raw?: unknown;
  id?: string | null;
}

export type CDPSessionKind =
  | "dom"
  | "lifecycle"
  | "screenshot"
  | "extract";

export interface CDPClient {
  rootSession: CDPSession;
  createSession(descriptor?: CDPTargetDescriptor): Promise<CDPSession>;
  acquireSession(
    kind: CDPSessionKind,
    descriptor?: CDPTargetDescriptor
  ): Promise<CDPSession>;
  dispose(): Promise<void>;
  getPage?(): unknown;
}

export interface CDPFrameHandle {
  frameId: string;
  sessionId?: string;
  executionContextId?: number;
  isolatedWorldId?: number;
  backendNodeId?: number;
  driverFrame?: unknown;
}

export type CDPTargetDescriptor =
  | {
      type: "page";
      page?: unknown;
    }
  | {
      type: "frame";
      frame: unknown;
    }
  | {
      type: "element";
      element: unknown;
    }
  | {
      type: "raw";
      target: unknown;
    };
