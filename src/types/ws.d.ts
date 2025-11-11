declare module "ws" {
  import { EventEmitter } from "events";

  export type RawData = string | Buffer | ArrayBuffer | Buffer[];

  export default class WebSocket extends EventEmitter {
    static readonly CONNECTING: number;
    static readonly OPEN: number;
    static readonly CLOSING: number;
    static readonly CLOSED: number;

    readyState: number;

    constructor(address: string);

    send(data: string | Buffer): void;
    close(code?: number, reason?: string | Buffer): void;

    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
  }
}
