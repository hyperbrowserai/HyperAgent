import { chromium, Browser, LaunchOptions } from "playwright";
import BrowserProvider from "@/types/browser-providers/types";
import { HyperagentError } from "@/agent/error";

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
  public getSession(): Browser {
    if (!this.session) {
      throw new HyperagentError("Local Browser not initialized yet");
    }
    return this.session;
  }
}
