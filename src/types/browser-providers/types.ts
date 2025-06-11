import { Browser, BrowserContext } from "playwright";

abstract class BrowserProvider<T> {
  abstract session: unknown;
  abstract start(): Promise<Browser>;
  abstract close(): Promise<void>;
  abstract getSession(): T | null;
  abstract getContext(device?: string): Promise<BrowserContext | null>;
}

export default BrowserProvider;
