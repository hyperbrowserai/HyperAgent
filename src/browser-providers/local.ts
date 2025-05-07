import {
  chromium,
  Browser,
  LaunchOptions,
  devices,
  BrowserContext,
} from "playwright";
import BrowserProvider from "@/types/browser-providers/types";

export class LocalBrowserProvider extends BrowserProvider<Browser> {
  options: Omit<Omit<LaunchOptions, "headless">, "channel"> | undefined;
  session: Browser | undefined;

  constructor(options?: Omit<Omit<LaunchOptions, "headless">, "channel">) {
    super();
    this.options = options;
  }

  async start(): Promise<Browser> {
    const launchArgs = this.options?.args ?? [];
    const browser = await chromium.launch({
      ...(this.options ?? {}),
      channel: "chrome",
      headless: false,
      args: ["--disable-blink-features=AutomationControlled", ...launchArgs],
    });
    this.session = browser;
    return this.session;
  }

  async close(): Promise<void> {
    return await this.session?.close();
  }

  public getSession() {
    if (!this.session) {
      return null;
    }
    return this.session;
  }

  public async getContext(
    device: string = "desktop"
  ): Promise<BrowserContext | null> {
    if (!this.session) return null;

    if (device === "mobile") {
      const iPhone = devices["iPhone 12"];
      return await this.session.newContext({
        ...iPhone,
      });
    }

    return await this.session.newContext();
  }
}
