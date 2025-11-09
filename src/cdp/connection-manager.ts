import { EventEmitter } from "events";
import { spawn, ChildProcess } from "child_process";
import WebSocket from "ws";
import * as http from "http";
import * as Protocol from "devtools-protocol";

/**
 * CDP Connection Manager
 * Manages Chrome DevTools Protocol connections without Playwright dependency
 */

export interface LaunchLocalOptions {
  headless?: boolean;
  userDataDir?: string;
  args?: string[];
  executablePath?: string;
  port?: number;
}

export interface CDPSession {
  sessionId: string;
  targetId: string;
  ws: WebSocket;
  messageId: number;
  callbacks: Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>;
  eventListeners: Map<string, ((params: any) => void)[]>;
}

export interface CDPTarget {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached?: boolean;
  canAccessOpener?: boolean;
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface CDPConnectionManagerEvents {
  statusChange: (status: ConnectionStatus) => void;
  connected: () => void;
  disconnected: () => void;
  error: (error: Error) => void;
  targetCreated: (target: CDPTarget) => void;
  targetDestroyed: (targetId: string) => void;
}

/**
 * Main CDP Connection Manager class
 * Handles both local Chrome launching and remote CDP endpoint connections
 */
export class CDPConnectionManager extends EventEmitter {
  private chromeProcess: ChildProcess | null = null;
  private endpointUrl: string | null = null;
  private browserSession: CDPSession | null = null;
  private sessions: Map<string, CDPSession> = new Map();
  private status: ConnectionStatus = "disconnected";
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private reconnectDelay = 2000;
  private commandTimeout = 30000; // 30 seconds

  constructor() {
    super();
  }

  /**
   * Launch Chrome locally with remote debugging enabled
   */
  async launchLocal(options: LaunchLocalOptions = {}): Promise<string> {
    this.log("Launching local Chrome instance...");

    const port = options.port || 9222;
    const headless = options.headless !== undefined ? options.headless : false;
    const executablePath = options.executablePath || this.findChromePath();

    const args: string[] = [
      `--remote-debugging-port=${port}`,
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      ...(options.userDataDir ? [`--user-data-dir=${options.userDataDir}`] : []),
      ...(headless ? ["--headless=new"] : []),
      ...(options.args || []),
    ];

    return new Promise((resolve, reject) => {
      try {
        this.chromeProcess = spawn(executablePath, args, {
          stdio: ["ignore", "pipe", "pipe"],
        });

        if (!this.chromeProcess || !this.chromeProcess.stderr) {
          reject(new Error("Failed to spawn Chrome process"));
          return;
        }

        let output = "";

        this.chromeProcess.stderr.on("data", (data: Buffer) => {
          output += data.toString();
          const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
          if (match) {
            const wsUrl = match[1];
            this.log(`Chrome launched successfully. WebSocket URL: ${wsUrl}`);

            // Extract HTTP endpoint from WS URL
            const httpUrl = wsUrl.replace("ws://", "http://").replace(/\/devtools\/browser\/.*$/, "");
            this.endpointUrl = httpUrl;
            resolve(httpUrl);
          }
        });

        this.chromeProcess.on("error", (error: Error) => {
          this.logError("Chrome process error:", error);
          reject(error);
        });

        this.chromeProcess.on("exit", (code: number | null) => {
          this.log(`Chrome process exited with code ${code}`);
          this.chromeProcess = null;
          if (this.status === "connected") {
            this.handleDisconnection();
          }
        });

        // Timeout after 10 seconds if Chrome doesn't start
        setTimeout(() => {
          if (!this.endpointUrl) {
            reject(new Error("Timeout waiting for Chrome to start"));
            this.killChrome();
          }
        }, 10000);

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Connect to a remote CDP endpoint
   */
  async connect(endpoint: string, autoReconnect: boolean = true): Promise<void> {
    this.log(`Connecting to CDP endpoint: ${endpoint}`);
    this.endpointUrl = endpoint;
    this.setStatus("connecting");

    try {
      // Get browser WebSocket endpoint
      const browserWsUrl = await this.getBrowserWebSocketUrl(endpoint);

      // Create browser session
      this.browserSession = await this.createWebSocketSession(browserWsUrl, "browser");

      this.setStatus("connected");
      this.emit("connected");
      this.reconnectAttempts = 0;

      this.log("Connected to CDP endpoint successfully");

    } catch (error) {
      this.setStatus("error");
      this.emit("error", error as Error);

      if (autoReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        this.log(`Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${this.reconnectDelay}ms...`);
        setTimeout(() => {
          this.connect(endpoint, autoReconnect);
        }, this.reconnectDelay * this.reconnectAttempts);
      } else {
        throw error;
      }
    }
  }

  /**
   * Create a new CDP session for a specific target (page/frame)
   */
  async createSession(targetId?: string): Promise<CDPSession> {
    if (!this.browserSession) {
      throw new Error("Not connected to browser. Call connect() first.");
    }

    // If no targetId provided, create a new page target
    let actualTargetId: string;
    if (!targetId) {
      const result = await this.sendCommand(this.browserSession, "Target.createTarget", {
        url: "about:blank",
      });
      actualTargetId = result.targetId;
      this.log(`Created new target: ${actualTargetId}`);
    } else {
      actualTargetId = targetId;
    }

    // Attach to the target
    const { sessionId } = await this.sendCommand(this.browserSession, "Target.attachToTarget", {
      targetId: actualTargetId,
      flatten: true,
    });

    this.log(`Attached to target ${actualTargetId} with session ${sessionId}`);

    // Get target WebSocket URL
    const targets = await this.listTargets();
    const target = targets.find((t) => t.targetId === actualTargetId);

    if (!target) {
      throw new Error(`Target ${actualTargetId} not found`);
    }

    // Create session using the browser session for communication
    const session: CDPSession = {
      sessionId,
      targetId: actualTargetId,
      ws: this.browserSession.ws,
      messageId: 0,
      callbacks: new Map(),
      eventListeners: new Map(),
    };

    this.sessions.set(sessionId, session);

    return session;
  }

  /**
   * Send a CDP command to a session
   */
  async sendCommand(
    session: CDPSession,
    method: string,
    params?: any
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket is not open"));
        return;
      }

      const id = ++session.messageId;
      const message: any = { id, method };

      if (params) {
        message.params = params;
      }

      // For target sessions, include sessionId
      if (session.sessionId && session.sessionId !== "browser") {
        message.sessionId = session.sessionId;
      }

      // Set up timeout
      const timer = setTimeout(() => {
        session.callbacks.delete(id);
        reject(new Error(`Command timeout: ${method}`));
      }, this.commandTimeout);

      // Store callback
      session.callbacks.set(id, { resolve, reject, timer });

      // Send message
      const messageStr = JSON.stringify(message);
      this.log(`→ ${method}`, params || "");
      session.ws.send(messageStr);
    });
  }

  /**
   * List all available targets
   */
  async listTargets(): Promise<CDPTarget[]> {
    if (!this.browserSession) {
      throw new Error("Not connected to browser");
    }

    const result = await this.sendCommand(this.browserSession, "Target.getTargets", {});
    return result.targetInfos.map((info: any) => ({
      targetId: info.targetId,
      type: info.type,
      title: info.title,
      url: info.url,
      attached: info.attached,
      canAccessOpener: info.canAccessOpener,
    }));
  }

  /**
   * Create a new target (page/tab)
   */
  async createTarget(url: string = "about:blank"): Promise<string> {
    if (!this.browserSession) {
      throw new Error("Not connected to browser");
    }

    const result = await this.sendCommand(this.browserSession, "Target.createTarget", {
      url,
    });

    this.log(`Created new target: ${result.targetId}`);
    this.emit("targetCreated", { targetId: result.targetId, url });

    return result.targetId;
  }

  /**
   * Close a target
   */
  async closeTarget(targetId: string): Promise<boolean> {
    if (!this.browserSession) {
      throw new Error("Not connected to browser");
    }

    const result = await this.sendCommand(this.browserSession, "Target.closeTarget", {
      targetId,
    });

    if (result.success) {
      this.log(`Closed target: ${targetId}`);
      this.emit("targetDestroyed", targetId);

      // Clean up session if it exists
      for (const [sessionId, session] of this.sessions.entries()) {
        if (session.targetId === targetId) {
          this.sessions.delete(sessionId);
        }
      }
    }

    return result.success;
  }

  /**
   * Attach to an existing target
   */
  async attachToTarget(targetId: string): Promise<CDPSession> {
    return this.createSession(targetId);
  }

  /**
   * Listen to CDP events on a session
   */
  addEventListener(session: CDPSession, event: string, listener: (params: any) => void): void {
    const listeners = session.eventListeners.get(event) || [];
    listeners.push(listener);
    session.eventListeners.set(event, listeners);
  }

  /**
   * Remove event listener from a session
   */
  removeEventListener(session: CDPSession, event: string, listener: (params: any) => void): void {
    const listeners = session.eventListeners.get(event) || [];
    const index = listeners.indexOf(listener);
    if (index > -1) {
      listeners.splice(index, 1);
      session.eventListeners.set(event, listeners);
    }
  }

  /**
   * Get current connection status
   */
  getStatus(): ConnectionStatus {
    return this.status;
  }

  /**
   * Close all connections and cleanup
   */
  async close(): Promise<void> {
    this.log("Closing CDP connection manager...");

    // Close all sessions
    for (const [sessionId, session] of this.sessions.entries()) {
      this.closeSession(session);
    }
    this.sessions.clear();

    // Close browser session
    if (this.browserSession) {
      this.closeSession(this.browserSession);
      this.browserSession = null;
    }

    // Kill Chrome process if running
    this.killChrome();

    this.setStatus("disconnected");
    this.log("CDP connection manager closed");
  }

  // Private helper methods

  private findChromePath(): string {
    const platform = process.platform;

    if (platform === "darwin") {
      return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    } else if (platform === "win32") {
      return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    } else {
      // Linux
      const paths = [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
      ];

      for (const path of paths) {
        try {
          require("fs").accessSync(path);
          return path;
        } catch (e) {
          continue;
        }
      }

      return "google-chrome";
    }
  }

  private async getBrowserWebSocketUrl(endpoint: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL("/json/version", endpoint);

      http.get(url.toString(), (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json.webSocketDebuggerUrl) {
              resolve(json.webSocketDebuggerUrl);
            } else {
              reject(new Error("No webSocketDebuggerUrl found in response"));
            }
          } catch (error) {
            reject(error);
          }
        });
      }).on("error", (error) => {
        reject(error);
      });
    });
  }

  private async createWebSocketSession(wsUrl: string, type: "browser" | "target"): Promise<CDPSession> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);

      const session: CDPSession = {
        sessionId: type === "browser" ? "browser" : "",
        targetId: "",
        ws,
        messageId: 0,
        callbacks: new Map(),
        eventListeners: new Map(),
      };

      ws.on("open", () => {
        this.log(`WebSocket connected: ${wsUrl}`);
        resolve(session);
      });

      ws.on("message", (data: WebSocket.Data) => {
        this.handleMessage(session, data.toString());
      });

      ws.on("error", (error: Error) => {
        this.logError("WebSocket error:", error);
        reject(error);
      });

      ws.on("close", () => {
        this.log("WebSocket closed");
        this.handleDisconnection();
      });
    });
  }

  private handleMessage(session: CDPSession, data: string): void {
    try {
      const message = JSON.parse(data);

      // Handle command response
      if (message.id !== undefined) {
        const callback = session.callbacks.get(message.id);
        if (callback) {
          clearTimeout(callback.timer);
          session.callbacks.delete(message.id);

          if (message.error) {
            this.logError(`← Error (${message.id}):`, message.error);
            callback.reject(new Error(`CDP Error: ${message.error.message}`));
          } else {
            this.log(`← Response (${message.id}):`, message.result || "success");
            callback.resolve(message.result || {});
          }
        }
      }

      // Handle event
      if (message.method) {
        this.log(`← Event: ${message.method}`, message.params || "");

        const listeners = session.eventListeners.get(message.method) || [];
        listeners.forEach((listener) => {
          try {
            listener(message.params || {});
          } catch (error) {
            this.logError(`Error in event listener for ${message.method}:`, error);
          }
        });
      }

      // Handle session-specific events
      if (message.sessionId) {
        const targetSession = this.sessions.get(message.sessionId);
        if (targetSession && message.method) {
          const listeners = targetSession.eventListeners.get(message.method) || [];
          listeners.forEach((listener) => {
            try {
              listener(message.params || {});
            } catch (error) {
              this.logError(`Error in session event listener for ${message.method}:`, error);
            }
          });
        }
      }

    } catch (error) {
      this.logError("Error parsing CDP message:", error);
    }
  }

  private closeSession(session: CDPSession): void {
    // Clear all pending callbacks
    for (const [id, callback] of session.callbacks.entries()) {
      clearTimeout(callback.timer);
      callback.reject(new Error("Session closed"));
    }
    session.callbacks.clear();

    // Clear event listeners
    session.eventListeners.clear();

    // Close WebSocket if not shared with browser session
    if (session !== this.browserSession && session.ws) {
      session.ws.close();
    }
  }

  private killChrome(): void {
    if (this.chromeProcess) {
      try {
        this.log("Killing Chrome process...");
        this.chromeProcess.kill("SIGTERM");

        // Force kill after 5 seconds if still running
        setTimeout(() => {
          if (this.chromeProcess && !this.chromeProcess.killed) {
            this.chromeProcess.kill("SIGKILL");
          }
        }, 5000);

      } catch (error) {
        this.logError("Error killing Chrome process:", error);
      }
      this.chromeProcess = null;
    }
  }

  private handleDisconnection(): void {
    if (this.status === "connected") {
      this.setStatus("disconnected");
      this.emit("disconnected");
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.emit("statusChange", status);
    }
  }

  private log(message: string, data?: any): void {
    if (data !== undefined) {
      console.log(`[CDP] ${message}`, data);
    } else {
      console.log(`[CDP] ${message}`);
    }
  }

  private logError(message: string, error: any): void {
    console.error(`[CDP] ${message}`, error);
  }
}

export default CDPConnectionManager;
