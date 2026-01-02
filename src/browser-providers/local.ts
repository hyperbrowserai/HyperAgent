import { chromium, Browser, LaunchOptions } from "playwright-core";
import BrowserProvider from "@/types/browser-providers/types";

export class LocalBrowserProvider extends BrowserProvider<Browser> {
  options: LaunchOptions | undefined;
  session: Browser | undefined;
  constructor(options?: LaunchOptions) {
    super();
    this.options = options;
  }
  async start(): Promise<Browser> {
    const launchArgs = this.options?.args ?? [];
    const browser = await chromium.launch({
      ...(this.options ?? {}),
      channel: this.options?.channel ?? "chrome",
      headless: this.options?.headless ?? false,
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
}
