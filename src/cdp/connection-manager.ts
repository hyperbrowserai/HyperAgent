import WebSocket from "ws";
import { EventEmitter } from "events";
import * as chromeLauncher from "chrome-launcher";
import { Protocol } from "devtools-protocol";

export interface CDPSession {
  sessionId: string;
  targetId: string;
  ws: WebSocket;
  messageId: number;
  pendingCommands: Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    method: string;
    timeout: NodeJS.Timeout;
  }>;
}

export interface LaunchOptions {
  headless?: boolean;
  port?: number;
  chromeFlags?: string[];
  chromePath?: string;
  userDataDir?: string;
}

export interface ConnectionOptions {
  timeout?: number;
  reconnectAttempts?: number;
  reconnectDelay?: number;
}

export type ConnectionStatus = "connected" | "disconnected" | "error" | "reconnecting";

export class CDPConnectionManager extends EventEmitter {
  private chromeProcess: chromeLauncher.LaunchedChrome | null = null;
  private browserWs: WebSocket | null = null;
  private sessions: Map<string, CDPSession> = new Map();
  private browserSession: CDPSession | null = null;
  private browserEndpoint: string | null = null;
  private connectionStatus: ConnectionStatus = "disconnected";
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 3;
  private reconnectDelay: number = 1000;
  private commandTimeout: number = 30000;
  private browserMessageId: number = 0;

  constructor(options?: ConnectionOptions) {
    super();
    if (options?.reconnectAttempts !== undefined) {
      this.maxReconnectAttempts = options.reconnectAttempts;
    }
    if (options?.reconnectDelay !== undefined) {
      this.reconnectDelay = options.reconnectDelay;
    }
    if (options?.timeout !== undefined) {
      this.commandTimeout = options.timeout;
    }
  }

  async launchLocal(options: LaunchOptions = {}): Promise<string> {
    console.log("[CDP] Launching local Chrome instance...");
    
    try {
      const chromeFlags = [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        ...(options.chromeFlags || [])
      ];

      const launchOptions: chromeLauncher.Options = {
        chromeFlags,
        port: options.port,
        chromePath: options.chromePath,
        userDataDir: options.userDataDir,
        logLevel: "error"
      };

      this.chromeProcess = await chromeLauncher.launch(launchOptions);
      
      const port = this.chromeProcess.port;
      this.browserEndpoint = `http://localhost:${port}`;
      
      console.log(`[CDP] Chrome launched successfully on port ${port}`);
      console.log(`[CDP] Debug endpoint: ${this.browserEndpoint}`);

      const versionUrl = `${this.browserEndpoint}/json/version`;
      let wsEndpoint: string | null = null;
      let retries = 10;
      
      while (retries > 0 && !wsEndpoint) {
        try {
          const response = await fetch(versionUrl);
          const versionInfo = await response.json();
          wsEndpoint = versionInfo.webSocketDebuggerUrl;
        } catch (error) {
          retries--;
          if (retries === 0) {
            throw error;
          }
          console.log(`[CDP] Waiting for Chrome to be ready... (${retries} retries left)`);
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      if (!wsEndpoint) {
        throw new Error("Failed to get WebSocket endpoint from Chrome");
      }

      console.log(`[CDP] WebSocket endpoint: ${wsEndpoint}`);
      
      return wsEndpoint;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[CDP] Failed to launch Chrome: ${errorMessage}`);
      throw new Error(`Failed to launch Chrome: ${errorMessage}`);
    }
  }

  async connect(endpoint: string): Promise<void> {
    console.log(`[CDP] Connecting to endpoint: ${endpoint}`);
    
    return new Promise((resolve, reject) => {
      try {
        this.browserWs = new WebSocket(endpoint);

        const connectionTimeout = setTimeout(() => {
          if (this.browserWs) {
            this.browserWs.close();
          }
          reject(new Error("Connection timeout"));
        }, this.commandTimeout);

        this.browserWs.on("open", () => {
          clearTimeout(connectionTimeout);
          this.connectionStatus = "connected";
          this.reconnectAttempts = 0;
          
          this.browserSession = {
            sessionId: "browser",
            targetId: "browser",
            ws: this.browserWs!,
            messageId: 0,
            pendingCommands: new Map()
          };
          this.sessions.set("browser", this.browserSession);
          
          console.log("[CDP] Connected successfully");
          this.emit("connected");
          resolve();
        });

        this.browserWs.on("message", (data: WebSocket.Data) => {
          this.handleBrowserMessage(data);
        });

        this.browserWs.on("error", (error: Error) => {
          clearTimeout(connectionTimeout);
          console.error(`[CDP] WebSocket error: ${error.message}`);
          this.connectionStatus = "error";
          this.emit("error", error);
          reject(error);
        });

        this.browserWs.on("close", () => {
          console.log("[CDP] Connection closed");
          this.connectionStatus = "disconnected";
          this.emit("disconnected");
          this.handleDisconnection();
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[CDP] Connection failed: ${errorMessage}`);
        reject(new Error(`Connection failed: ${errorMessage}`));
      }
    });
  }

  private handleBrowserMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.id !== undefined) {
        const session = Array.from(this.sessions.values()).find(s => 
          s.pendingCommands.has(message.id)
        );
        
        if (session) {
          const pending = session.pendingCommands.get(message.id);
          if (pending) {
            clearTimeout(pending.timeout);
            session.pendingCommands.delete(message.id);
            
            if (message.error) {
              console.error(`[CDP] Command error: ${pending.method}`, message.error);
              pending.reject(new Error(`CDP Error: ${message.error.message || JSON.stringify(message.error)}`));
            } else {
              pending.resolve(message.result);
            }
          }
        }
      }
    } catch (error) {
      console.error("[CDP] Failed to parse message:", error);
    }
  }

  private async handleDisconnection(): Promise<void> {
    if (this.reconnectAttempts < this.maxReconnectAttempts && this.browserEndpoint) {
      this.reconnectAttempts++;
      this.connectionStatus = "reconnecting";
      console.log(`[CDP] Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
      
      await new Promise(resolve => setTimeout(resolve, this.reconnectDelay));
      
      try {
        const versionUrl = `${this.browserEndpoint}/json/version`;
        const response = await fetch(versionUrl);
        const versionInfo = await response.json();
        const wsEndpoint = versionInfo.webSocketDebuggerUrl;
        await this.connect(wsEndpoint);
      } catch {
        console.error(`[CDP] Reconnection attempt ${this.reconnectAttempts} failed`);
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          console.error("[CDP] Max reconnection attempts reached");
          this.emit("error", new Error("Max reconnection attempts reached"));
        }
      }
    }
  }

  async createSession(targetId?: string): Promise<CDPSession> {
    if (!this.browserWs || this.connectionStatus !== "connected") {
      throw new Error("Not connected to browser");
    }

    let actualTargetId = targetId;
    
    if (!actualTargetId) {
      console.log("[CDP] No target ID provided, creating new page target...");
      const newTarget = await this.createTarget("about:blank");
      actualTargetId = newTarget.targetId;
    }

    console.log(`[CDP] Creating session for target: ${actualTargetId}`);

    const attachResult = await this.sendBrowserCommand("Target.attachToTarget", {
      targetId: actualTargetId,
      flatten: true
    }) as { sessionId: string };

    const sessionId = attachResult.sessionId;
    
    const session: CDPSession = {
      sessionId,
      targetId: actualTargetId,
      ws: this.browserWs,
      messageId: 0,
      pendingCommands: new Map()
    };

    this.sessions.set(sessionId, session);
    console.log(`[CDP] Session created: ${sessionId}`);

    return session;
  }

  private async sendBrowserCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.browserWs || this.connectionStatus !== "connected" || !this.browserSession) {
      throw new Error("Not connected to browser");
    }

    return new Promise((resolve, reject) => {
      this.browserMessageId++;
      const id = this.browserMessageId;
      
      const message = {
        id,
        method,
        params: params || {}
      };

      const timeout = setTimeout(() => {
        this.browserSession!.pendingCommands.delete(id);
        reject(new Error(`Command timeout: ${method}`));
      }, this.commandTimeout);

      this.browserSession!.pendingCommands.set(id, {
        resolve,
        reject,
        method,
        timeout
      });

      this.browserWs!.send(JSON.stringify(message), (error) => {
        if (error) {
          clearTimeout(timeout);
          this.browserSession!.pendingCommands.delete(id);
          reject(new Error(`Failed to send command: ${error.message}`));
        }
      });
    });
  }

  async sendCommand(session: CDPSession, method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!session.ws || this.connectionStatus !== "connected") {
      throw new Error("Session not connected");
    }

    console.log(`[CDP] Sending command: ${method}`);

    return new Promise((resolve, reject) => {
      session.messageId++;
      const id = session.messageId;

      const message = {
        id,
        method,
        params: params || {},
        sessionId: session.sessionId
      };

      const timeout = setTimeout(() => {
        session.pendingCommands.delete(id);
        reject(new Error(`Command timeout: ${method}`));
      }, this.commandTimeout);

      session.pendingCommands.set(id, {
        resolve,
        reject,
        method,
        timeout
      });

      session.ws.send(JSON.stringify(message), (error) => {
        if (error) {
          clearTimeout(timeout);
          session.pendingCommands.delete(id);
          console.error(`[CDP] Failed to send command ${method}: ${error.message}`);
          reject(new Error(`Failed to send command: ${error.message}`));
        }
      });
    });
  }

  async listTargets(): Promise<Protocol.Target.TargetInfo[]> {
    console.log("[CDP] Listing targets...");
    
    try {
      const result = await this.sendBrowserCommand("Target.getTargets") as { targetInfos: Protocol.Target.TargetInfo[] };
      const targets = result.targetInfos || [];
      console.log(`[CDP] Found ${targets.length} targets`);
      return targets;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[CDP] Failed to list targets: ${errorMessage}`);
      throw new Error(`Failed to list targets: ${errorMessage}`);
    }
  }

  async createTarget(url: string): Promise<Protocol.Target.CreateTargetResponse> {
    console.log(`[CDP] Creating new target with URL: ${url}`);
    
    try {
      const result = await this.sendBrowserCommand("Target.createTarget", {
        url
      }) as Protocol.Target.CreateTargetResponse;
      console.log(`[CDP] Target created: ${result.targetId}`);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[CDP] Failed to create target: ${errorMessage}`);
      throw new Error(`Failed to create target: ${errorMessage}`);
    }
  }

  async attachToTarget(targetId: string): Promise<CDPSession> {
    console.log(`[CDP] Attaching to target: ${targetId}`);
    
    try {
      return await this.createSession(targetId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[CDP] Failed to attach to target: ${errorMessage}`);
      throw new Error(`Failed to attach to target: ${errorMessage}`);
    }
  }

  async closeTarget(targetId: string): Promise<void> {
    console.log(`[CDP] Closing target: ${targetId}`);
    
    try {
      await this.sendBrowserCommand("Target.closeTarget", { targetId });
      
      const sessionsToRemove = Array.from(this.sessions.entries())
        .filter(([, session]) => session.targetId === targetId)
        .map(([sessionId]) => sessionId);
      
      for (const sessionId of sessionsToRemove) {
        this.sessions.delete(sessionId);
      }
      
      console.log(`[CDP] Target closed: ${targetId}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[CDP] Failed to close target: ${errorMessage}`);
      throw new Error(`Failed to close target: ${errorMessage}`);
    }
  }

  async close(): Promise<void> {
    console.log("[CDP] Closing CDP connection manager...");
    
    for (const [, session] of this.sessions.entries()) {
      for (const [, pending] of session.pendingCommands.entries()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Connection closed"));
      }
      session.pendingCommands.clear();
    }
    
    this.sessions.clear();

    if (this.browserWs) {
      this.browserWs.removeAllListeners();
      if (this.browserWs.readyState === WebSocket.OPEN) {
        this.browserWs.close();
      }
      this.browserWs = null;
    }

    if (this.chromeProcess) {
      try {
        await this.chromeProcess.kill();
        console.log("[CDP] Chrome process terminated");
      } catch (error) {
        console.error("[CDP] Error killing Chrome process:", error);
      }
      this.chromeProcess = null;
    }

    this.connectionStatus = "disconnected";
    this.browserEndpoint = null;
    this.reconnectAttempts = 0;
    
    console.log("[CDP] Connection manager closed");
  }

  getStatus(): ConnectionStatus {
    return this.connectionStatus;
  }

  getSession(sessionId: string): CDPSession | undefined {
    return this.sessions.get(sessionId);
  }

  getAllSessions(): CDPSession[] {
    return Array.from(this.sessions.values());
  }
}
