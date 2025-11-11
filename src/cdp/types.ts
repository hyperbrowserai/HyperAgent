export interface CDPSession {
  send<T = any, P = Record<string, unknown>>(
    method: string,
    params?: P
  ): Promise<T>;
  on(event: string, handler: (...payload: any[]) => void): void;
  off?(event: string, handler: (...payload: any[]) => void): void;
  detach(): Promise<void>;
  raw?: unknown;
}

export interface CDPClient {
  rootSession: CDPSession;
  createSession(descriptor?: CDPTargetDescriptor): Promise<CDPSession>;
  dispose(): Promise<void>;
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
