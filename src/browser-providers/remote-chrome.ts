import { chromium, Browser, ConnectOverCDPOptions } from "playwright-core";
import BrowserProvider from "@/types/browser-providers/types";

export interface RemoteChromeConfig {
  wsEndpoint: string;
  browserConfig?: Omit<ConnectOverCDPOptions, "endpointURL">;
}

export class RemoteChromeProvider extends BrowserProvider<Browser> {
  config: RemoteChromeConfig;
  session: Browser | undefined;
  debug: boolean;

  constructor(config: RemoteChromeConfig, debug: boolean = false) {
    super();
    this.config = config;
    this.debug = debug;
    this.session = undefined;
  }

  async start(): Promise<Browser> {
    if (this.debug) {
      console.log("\nConnecting to remote Chrome:", this.config.wsEndpoint, "\n");
    }

    this.session = await chromium.connectOverCDP(
      this.config.wsEndpoint,
      this.config.browserConfig
    );

    if (this.debug) {
      console.log("\nConnected to remote Chrome:", this.config.wsEndpoint, "\n");
    }

    return this.session;
  }

  async close(): Promise<void> {
    await this.session?.close();
  }

  public getSession() {
    if (!this.session) {
      return null;
    }
    return this.session;
  }
}
