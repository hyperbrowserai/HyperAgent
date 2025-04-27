import { chromium, Browser, ConnectOverCDPOptions } from "playwright";
import { Hyperbrowser } from "@hyperbrowser/sdk";
import {
  CreateSessionParams,
  HyperbrowserConfig,
  SessionDetail,
} from "@hyperbrowser/sdk/types";

import BrowserProvider from "@/types/browser-providers/types";

export class HyperbrowserProvider extends BrowserProvider<SessionDetail> {
  browserConfig: Omit<ConnectOverCDPOptions, "endpointURL"> | undefined;
  sessionConfig: CreateSessionParams | undefined;
  config: HyperbrowserConfig | undefined;
  browser: Browser | undefined;
  session: SessionDetail | undefined;
  hbClient: Hyperbrowser | undefined;
  debug: boolean;
  keepBrowserOpen: boolean;
  externallyManaged: boolean;

  constructor(params?: {
    debug?: boolean;
    browserConfig?: Omit<ConnectOverCDPOptions, "endpointURL">;
    sessionConfig?: CreateSessionParams;
    config?: HyperbrowserConfig;
    client?: Hyperbrowser;
    session?: SessionDetail;
    keepBrowserOpen?: boolean;
  }) {
    super();
    this.debug = params?.debug ?? false;
    this.browserConfig = params?.browserConfig;
    this.sessionConfig = params?.sessionConfig;
    this.config = params?.config;
    this.keepBrowserOpen = params?.keepBrowserOpen ?? false;
    if (params?.client && params?.session) {
      this.hbClient = params.client;
      this.session = params.session;
      this.externallyManaged = true;
    } else this.externallyManaged = false;
  }

  async start(): Promise<Browser> {
    if (!this.externallyManaged) {
      this.hbClient = new Hyperbrowser(this.config);
      this.session = await this.hbClient.sessions.create(this.sessionConfig);
    }

    if (!this.session) {
      throw new Error("Failed to initialize or acquire a Hyperbrowser session");
    }

    const wsEndpoint = this.keepBrowserOpen 
      ? this.session.wsEndpoint + (this.session.wsEndpoint.includes('?') ? '&' : '?') + 'keepAlive=true'
      : this.session.wsEndpoint;

    this.browser = await chromium.connectOverCDP(
      wsEndpoint,
      this.browserConfig
    );

    if (this.debug) {
      console.log(
        "\nHyperbrowser session info:",
        {
          liveUrl: this.session.liveUrl,
          sessionID: this.session.id,
          infoUrl: this.session.sessionUrl,
        },
        "\n"
      );
    }

    return this.browser;
  }

  async close(): Promise<void> {
    await this.browser?.close();
    // Only stop the session if it's internally managed
    if (!this.externallyManaged && this.session) {
      await this.hbClient?.sessions.stop(this.session.id);
    }
  }

  public getSession() {
    if (!this.session) {
      return null;
    }
    return this.session;
  }
}
