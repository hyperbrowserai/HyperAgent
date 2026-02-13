import { chromium, Browser, ConnectOverCDPOptions } from "playwright-core";
import { Hyperbrowser } from "@hyperbrowser/sdk";
import {
  CreateSessionParams,
  HyperbrowserConfig,
  SessionDetail,
} from "@hyperbrowser/sdk/types";

import BrowserProvider from "@/types/browser-providers/types";
import { formatUnknownError } from "@/utils";

const MAX_HYPERBROWSER_DIAGNOSTIC_CHARS = 400;

const formatHyperbrowserDiagnostic = (value: unknown): string => {
  const normalized = formatUnknownError(value).replace(/\s+/g, " ").trim();
  const fallback = normalized.length > 0 ? normalized : "unknown error";
  if (fallback.length <= MAX_HYPERBROWSER_DIAGNOSTIC_CHARS) {
    return fallback;
  }
  const omitted = fallback.length - MAX_HYPERBROWSER_DIAGNOSTIC_CHARS;
  return `${fallback.slice(
    0,
    MAX_HYPERBROWSER_DIAGNOSTIC_CHARS
  )}... [truncated ${omitted} chars]`;
};

export class HyperbrowserProvider extends BrowserProvider<SessionDetail> {
  browserConfig: Omit<ConnectOverCDPOptions, "endpointURL"> | undefined;
  sessionConfig: CreateSessionParams | undefined;
  config: HyperbrowserConfig | undefined;
  browser: Browser | undefined;
  session: SessionDetail | undefined;
  hbClient: Hyperbrowser | undefined;
  debug: boolean;

  constructor(params?: {
    debug?: boolean;
    browserConfig?: Omit<ConnectOverCDPOptions, "endpointURL">;
    sessionConfig?: CreateSessionParams;
    config?: HyperbrowserConfig;
  }) {
    super();
    this.debug = params?.debug ?? false;
    this.browserConfig = params?.browserConfig;
    this.sessionConfig = params?.sessionConfig;
    this.config = params?.config;
  }

  private async stopSessionSafely(
    client: Hyperbrowser,
    sessionId: string
  ): Promise<string | null> {
    try {
      await client.sessions.stop(sessionId);
      return null;
    } catch (error) {
      return `Failed to stop Hyperbrowser session ${sessionId}: ${formatHyperbrowserDiagnostic(
        error
      )}`;
    }
  }

  async start(): Promise<Browser> {
    const client = new Hyperbrowser(this.config);
    let session: SessionDetail;
    try {
      session = await client.sessions.create(this.sessionConfig);
    } catch (error) {
      throw new Error(
        `Failed to create Hyperbrowser session: ${formatHyperbrowserDiagnostic(
          error
        )}`
      );
    }

    this.hbClient = client;
    this.session = session;
    const endpoint =
      typeof session.wsEndpoint === "string" ? session.wsEndpoint.trim() : "";
    if (endpoint.length === 0) {
      const stopError = await this.stopSessionSafely(client, session.id);
      this.session = undefined;
      this.hbClient = undefined;
      const diagnostics = [
        "Failed to connect to Hyperbrowser session: missing wsEndpoint",
      ];
      if (stopError) {
        diagnostics.push(stopError);
      }
      throw new Error(diagnostics.join("; "));
    }

    try {
      this.browser = await chromium.connectOverCDP(endpoint, this.browserConfig);
    } catch (error) {
      const stopError = await this.stopSessionSafely(client, session.id);
      this.browser = undefined;
      this.session = undefined;
      this.hbClient = undefined;
      const diagnostics = [
        `Failed to connect to Hyperbrowser session: ${formatHyperbrowserDiagnostic(
          error
        )}`,
      ];
      if (stopError) {
        diagnostics.push(stopError);
      }
      throw new Error(diagnostics.join("; "));
    }

    if (this.debug) {
      console.log(
        "\nHyperbrowser session info:",
        {
          liveUrl: session.liveUrl,
          sessionID: session.id,
          infoUrl: session.sessionUrl,
        },
        "\n"
      );
    }

    return this.browser;
  }

  async close(): Promise<void> {
    const diagnostics: string[] = [];
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (error) {
        diagnostics.push(
          `Failed to close browser connection: ${formatHyperbrowserDiagnostic(
            error
          )}`
        );
      }
    }
    if (this.session && this.hbClient) {
      const stopError = await this.stopSessionSafely(
        this.hbClient,
        this.session.id
      );
      if (stopError) {
        diagnostics.push(stopError);
      }
    }
    this.browser = undefined;
    this.session = undefined;
    this.hbClient = undefined;
    if (diagnostics.length > 0) {
      throw new Error(diagnostics.join("; "));
    }
  }

  public getSession() {
    if (!this.session) {
      return null;
    }
    return this.session;
  }
}
