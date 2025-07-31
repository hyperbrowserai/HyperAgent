import { chromium, Browser, ConnectOverCDPOptions } from "playwright";
import BrowserProvider from "@/types/browser-providers/types";

export interface CDPBrowserConfig {
  wsEndpoint: string;
  options?: Omit<ConnectOverCDPOptions, "endpointURL">;
  debug?: boolean;
}

export class CDPBrowserProvider extends BrowserProvider<Browser> {
  wsEndpoint: string;
  options: Omit<ConnectOverCDPOptions, "endpointURL"> | undefined;
  session: Browser | undefined;
  debug: boolean;

  constructor(config: CDPBrowserConfig) {
    super();
    this.wsEndpoint = config.wsEndpoint;
    this.options = config.options;
    this.debug = config.debug ?? false;
  }

  async start(): Promise<Browser> {
    if (this.debug) {
      console.log("\nConnecting to CDP WebSocket endpoint:", this.wsEndpoint);
    }

    try {
      const browser = await chromium.connectOverCDP(this.wsEndpoint, this.options);
      this.session = browser;

      if (this.debug) {
        console.log("Successfully connected to CDP browser\n");
      }

      return this.session;
    } catch (error) {
      if (this.debug) {
        console.error("Failed to connect to CDP browser:", error);
      }
      throw new Error(`Failed to connect to CDP WebSocket endpoint: ${this.wsEndpoint}. ${error}`);
    }
  }

  async close(): Promise<void> {
    if (this.debug && this.session) {
      console.log("Closing CDP browser connection");
    }
    await this.session?.close();
  }

  public getSession() {
    if (!this.session) {
      return null;
    }
    return this.session;
  }
}
