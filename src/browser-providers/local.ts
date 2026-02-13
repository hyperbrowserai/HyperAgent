import { chromium, Browser, LaunchOptions } from "playwright-core";
import BrowserProvider from "@/types/browser-providers/types";
import { formatUnknownError } from "@/utils";

export type LocalBrowserProviderOptions = Omit<LaunchOptions, "channel"> & {
  channel?: string;
};

export class LocalBrowserProvider extends BrowserProvider<Browser> {
  private static readonly MAX_DIAGNOSTIC_CHARS = 400;
  options: LocalBrowserProviderOptions | undefined;
  session: Browser | undefined;
  constructor(options?: LocalBrowserProviderOptions) {
    super();
    this.options = options;
  }

  private formatDiagnostic(value: unknown): string {
    const normalized = formatUnknownError(value).replace(/\s+/g, " ").trim();
    const fallback = normalized.length > 0 ? normalized : "unknown error";
    if (fallback.length <= LocalBrowserProvider.MAX_DIAGNOSTIC_CHARS) {
      return fallback;
    }
    const omitted = fallback.length - LocalBrowserProvider.MAX_DIAGNOSTIC_CHARS;
    return `${fallback.slice(
      0,
      LocalBrowserProvider.MAX_DIAGNOSTIC_CHARS
    )}... [truncated ${omitted} chars]`;
  }

  async start(): Promise<Browser> {
    const launchArgs = this.options?.args ?? [];
    let browser: unknown;
    try {
      browser = await chromium.launch({
        ...(this.options ?? {}),
        channel: this.options?.channel ?? "chrome",
        headless: this.options?.headless ?? false,
        args: ["--disable-blink-features=AutomationControlled", ...launchArgs],
      });
    } catch (error) {
      throw new Error(
        `Failed to launch local browser: ${this.formatDiagnostic(error)}`
      );
    }

    if (!browser || typeof browser !== "object") {
      throw new Error("Local browser launch returned an invalid browser");
    }

    this.session = browser as Browser;
    return this.session;
  }
  async close(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (!session) {
      return;
    }
    try {
      await session.close();
    } catch (error) {
      throw new Error(
        `Failed to close local browser session: ${this.formatDiagnostic(error)}`
      );
    }
  }
  public getSession() {
    if (!this.session) {
      return null;
    }
    return this.session;
  }
}
