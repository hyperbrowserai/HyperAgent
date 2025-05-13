import { chromium, Browser, LaunchOptions, ConnectOptions } from "playwright";
import BrowserProvider from "@/types/browser-providers/types";

export class LocalBrowserProvider extends BrowserProvider<Browser> {
  options: (Omit<Omit<LaunchOptions, "headless">, "channel"> & { endpointURL?: string,args? : []}) | ConnectOptions  & { endpointURL?: string,args? : []} | undefined;
  session: Browser | undefined;
  constructor(options?: Omit<Omit<LaunchOptions, "headless">, "channel"> & { endpointURL?: string,args? : []}) {
    super();
    this.options = options;
  }
  async start(): Promise<Browser> {
    
    if (this.options && 'endpointURL' in this.options && this.options.endpointURL) {
      const browser = await chromium.connectOverCDP(this.options.endpointURL,{
        ...this.options
      });
      this.session = browser;
      return this.session;
    }
    const launchArgs = this.options?.args || [];
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
}
