import path from "path";
import fs from "fs/promises";
import { Browser, BrowserContext, Page } from "playwright-core";
import { v4 as uuidv4 } from "uuid";

import {
  BrowserProviders,
  HyperAgentOptions,
  MCPConfig,
  MCPServerConfig,
} from "@/types/config";
import { HyperAgentLLM, createLLMClient } from "@/llm/providers";
import { HyperAgentMessage } from "@/llm/types";
import {
  ActionContext,
  ActionType,
  AgentActionDefinition,
  endTaskStatuses,
  Task,
  TaskOutput,
  TaskParams,
  TaskState,
  TaskStatus,
} from "@/types";
import {
  CompleteActionDefinition,
  DEFAULT_ACTIONS,
  generateCompleteActionWithOutputDefinition,
} from "./actions";
import {
  HyperbrowserProvider,
  LocalBrowserProvider,
} from "../browser-providers";
import { HyperagentError } from "./error";
import {
  HyperAgentActError,
  HyperAgentError,
  HyperAgentExtractError,
  HyperAgentObserveError,
} from "@/error";
import { findElementWithInstruction } from "./shared/find-element";
import {
  A11yDOMState,
  AccessibilityNode,
  isEncodedId,
} from "../context-providers/a11y-dom/types";
import { MCPClient } from "./mcp/client";
import { runAgentTask } from "./tools/agent";
import { LLMUsagePayload } from "./tools/types";
import { HyperPage, HyperVariable } from "../types/agent/types";
import { z } from "zod";
import { AgentHistory, ErrorEmitter, MetricsTracker } from "../utils";
import { waitForSettledDOM } from "@/utils/waitForSettledDOM";
import { performance } from "perf_hooks";
import { ExamineDomResult } from "./examine-dom/types";
import { disposeAllCDPClients, resolveElement, dispatchCDPAction } from "@/cdp";
import { markDomSnapshotDirty } from "@/context-providers/a11y-dom/dom-cache";
import { setDebugOptions } from "@/debug/options";
import { initializeRuntimeContext } from "./shared/runtime-context";
import { performAction } from "./actions/shared/perform-action";
import { CacheKeyParts, CacheManager } from "@/utils/cache";
import { computeDomHash } from "@/context-providers/dom/dom-hash";
import { scopeDomWithSelector } from "@/context-providers/dom/selector-scope";
import { captureDOMState } from "./shared/dom-capture";
import { OperationType } from "@/types/metrics";
import { sha256, stableStringify } from "@/utils/hash";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  AgentHistoryEntry,
  HyperMetrics,
  InferenceLogEntry,
  TokenUsage,
} from "@/types";

type CacheTokens = {
  promptTokens?: number;
  completionTokens?: number;
};

interface CachePreparation<Result> {
  hit?: Result;
  domState?: A11yDOMState;
  domHash?: string;
  keyParts?: CacheKeyParts;
  warning?: string;
  write: (result: Result, durationMs: number, tokens?: CacheTokens) => void;
}

export class HyperAgent<T extends BrowserProviders = "Local"> {
  // aiAction configuration constants
  private static readonly AIACTION_CONFIG = {
    MAX_RETRIES: 10,
    RETRY_DELAY_MS: 1000,
    CLICK_TIMEOUT: 3500,
    MAX_DEBUG_ELEMENTS_TO_DISPLAY: 20,
    MAX_DEBUG_ELEMENTS_TO_STORE: 50,
    MAX_LABEL_LENGTH: 60,
  };

  private llm: HyperAgentLLM;
  private tasks: Record<string, TaskState> = {};
  private tokenLimit = 128000;
  private debug = false;
  private mcpClient: MCPClient | undefined;
  private browserProvider: T extends "Hyperbrowser"
    ? HyperbrowserProvider
  : LocalBrowserProvider;
  private browserProviderType: T;
  private actions: Array<AgentActionDefinition> = [...DEFAULT_ACTIONS];
  private cdpActionsEnabled: boolean;
  private cacheDir?: string;
  private cacheManager: CacheManager;
  private metricsTracker: MetricsTracker;
  private historyBuffer: AgentHistory;
  private inferenceLogPath?: string;
  private logMetricsEnabled: boolean;

  public browser: Browser | null = null;
  public context: BrowserContext | null = null;
  private _currentPage: Page | null = null;
  private _variables: Record<string, HyperVariable> = {};
  private errorEmitter: ErrorEmitter;

  public get currentPage(): HyperPage | null {
    if (this._currentPage) {
      return this.setupHyperPage(this._currentPage);
    }
    return null;
  }

  public set currentPage(page: Page) {
    this._currentPage = page;
  }

  constructor(params: HyperAgentOptions<T> = {}) {
    if (!params.llm) {
      if (process.env.OPENAI_API_KEY) {
        this.llm = createLLMClient({
          provider: "openai",
          model: "gpt-4o",
          temperature: 0,
        });
      } else {
        throw new HyperagentError("No LLM provider provided", 400);
      }
    } else if (typeof params.llm === "object" && "provider" in params.llm) {
      // It's an LLMConfig
      this.llm = createLLMClient(params.llm);
    } else {
      // It's already a HyperAgentLLM instance
      this.llm = params.llm;
    }
    this.browserProviderType = (params.browserProvider ?? "Local") as T;

    const cacheDirFromEnv = process.env.HYPERAGENT_CACHE_DIR;
    const resolvedCacheDir = params.cacheDir ?? cacheDirFromEnv;
    this.cacheDir = resolvedCacheDir ? path.resolve(resolvedCacheDir) : undefined;
    this.cacheManager = new CacheManager(this.cacheDir);
    this.metricsTracker = new MetricsTracker();
    this.historyBuffer = new AgentHistory(params.historyLimit ?? 200);
    this.inferenceLogPath = this.resolveInferenceLogPath(
      params.logInferenceToFile
    );
    this.logMetricsEnabled = params.logMetrics ?? false;

    setDebugOptions(params.debugOptions, this.debug);

    // TODO(Phase4): This legacy provider branch will be replaced by connector configs.
    this.browserProvider = (
      this.browserProviderType === "Hyperbrowser"
        ? new HyperbrowserProvider({
            ...(params.hyperbrowserConfig ?? {}),
            debug: params.debug,
          })
        : new LocalBrowserProvider(params.localConfig)
    ) as T extends "Hyperbrowser" ? HyperbrowserProvider : LocalBrowserProvider;

    if (params.customActions) {
      params.customActions.forEach(this.registerAction, this);
    }

    this.debug = params.debug ?? false;
    this.cdpActionsEnabled = params.cdpActions ?? true;
    this.errorEmitter = new ErrorEmitter();
  }

  /**
   *  This is just exposed as a utility function. You don't need to call it explicitly.
   * @returns A reference to the current rebrowser-playwright browser instance.
   */
  public async initBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await this.browserProvider.start();
      if (
        this.browserProviderType === "Hyperbrowser" &&
        this.browser.contexts().length > 0
      ) {
        this.context = this.browser.contexts()[0];
      } else {
        this.context = await this.browser.newContext({
          viewport: null,
        });
      }

      // Inject script to track event listeners
      await this.context.addInitScript(() => {
        // TODO: Check this list of events
        const interactiveEvents = new Set([
          "click",
          "mousedown",
          "mouseup",
          "keydown",
          "keyup",
          "keypress",
          "submit",
          "change",
          "input",
          "focus",
          "blur",
        ]); // Add more events as needed

        const originalAddEventListener = Element.prototype.addEventListener;
        Element.prototype.addEventListener = function (
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | AddEventListenerOptions
        ) {
          if (interactiveEvents.has(type.toLowerCase())) {
            this.setAttribute("data-has-interactive-listener", "true");
          }
          originalAddEventListener.call(this, type, listener, options);
        };
      });

      // Listen for new pages (tabs/popups)
      this.context.on("page", () => {
        if (this.debug) {
          console.log("New tab/popup detected");
        }

        // Note: We used to auto-switch this._currentPage here, but that breaks
        // scoped page interactions. If a user is awaiting pageA.ai(), and a new
        // tab opens, we don't want pageA to suddenly become pageB.
        // The user or the specific task logic should handle tab switching if desired.
      });

      return this.browser;
    }
    return this.browser;
  }

  /**
   * Use this function instead of accessing this.actions directly.
   * This function configures if there is a need for an output schema as a part of the complete action.
   * @param outputSchema
   * @returns
   */
  private getActions(
    outputSchema?: z.ZodType<any>
  ): Array<AgentActionDefinition> {
    if (outputSchema) {
      return [
        ...this.actions,
        generateCompleteActionWithOutputDefinition(outputSchema),
      ];
    } else {
      return [...this.actions, CompleteActionDefinition];
    }
  }

  /**
   * Get all variables
   * @returns Record of variables
   */
  public getVariables(): Record<string, HyperVariable> {
    return this._variables;
  }

  public get metrics(): HyperMetrics {
    return this.metricsTracker.snapshot();
  }

  public get history(): AgentHistoryEntry[] {
    return this.historyBuffer.snapshot();
  }

  /**
   * Set a variable
   * @param key Key of the variable
   * @param value Value of the variable
   */
  public addVariable(variable: HyperVariable): void {
    this._variables[variable.key] = variable;
  }

  /**
   * Get a variable
   * @param key Key of the variable
   * @returns Value of the variable
   */
  public getVariable(key: string): HyperVariable | undefined {
    return this._variables[key];
  }

  /**
   * Delete a variable
   * @param key Key of the variable
   */
  public deleteVariable(key: string): void {
    delete this._variables[key];
  }

  /**
   * Get all pages in the context
   * @returns Array of HyperPage objects
   */
  public async getPages(): Promise<HyperPage[]> {
    if (!this.browser) {
      await this.initBrowser();
    }
    if (!this.context) {
      throw new HyperagentError("No context found");
    }
    return this.context.pages().map(this.setupHyperPage.bind(this), this);
  }

  /**
   * Create a new page in the context
   * @returns HyperPage object
   */
  public async newPage(): Promise<HyperPage> {
    if (!this.browser) {
      await this.initBrowser();
    }
    if (!this.context) {
      throw new HyperagentError("No context found");
    }
    const page = await this.context.newPage();
    return this.setupHyperPage(page);
  }

  /**
   * Close the agent and all associated resources
   */
  public async closeAgent(): Promise<void> {
    await disposeAllCDPClients().catch((error) => {
      console.warn("[HyperAgent] Failed to dispose CDP clients:", error);
    });
    for (const taskId in this.tasks) {
      const task = this.tasks[taskId];
      if (!endTaskStatuses.has(task.status)) {
        task.status = TaskStatus.CANCELLED;
      }
    }

    if (this.mcpClient) {
      await this.mcpClient.disconnect();
      this.mcpClient = undefined;
    }

    if (this.browser) {
      await this.browserProvider.close();
      this.browser = null;
      this.context = null;
    }
  }

  /**
   * Clear all deterministic cache entries (best-effort).
   */
  public async clearCache(): Promise<void> {
    await this.cacheManager.clear();
  }

  /**
   * Get the current page or create a new one if none exists
   * @returns The current page
   */
  public async getCurrentPage(): Promise<Page> {
    if (!this.browser) {
      await this.initBrowser();
    }
    if (!this.context) {
      throw new HyperagentError("No context found");
    }

    // Poll context for new pages to catch any that opened since the last check
    // This handles race conditions where the 'page' event might not have fired yet
    // or where we missed it during a heavy operation.
    const pages = this.context.pages();
    if (pages.length > 0) {
      const lastPage = pages[pages.length - 1];
      // If the last page is different and not closed, switch to it
      // We prefer the newest page as it's likely the result of the user's last action
      if (
        lastPage &&
        !lastPage.isClosed() &&
        lastPage !== this._currentPage
      ) {
        if (this.debug) {
          console.log(
            `[HyperAgent] Polling detected new page, switching focus: ${lastPage.url()}`
          );
        }
        this._currentPage = lastPage;
      }
    }

    if (!this.currentPage || this.currentPage.isClosed()) {
      this._currentPage = await this.context.newPage();

      return this.setupHyperPage(this._currentPage);
    }
    return this.currentPage;
  }

  /**
   * Get task control object for a specific task
   * @param taskId ID of the task
   * @returns Task control object
   */
  private getTaskControl(taskId: string): Task {
    const taskState = this.tasks[taskId];
    if (!taskState) {
      throw new HyperagentError(`Task ${taskId} not found`);
    }
    return {
      getStatus: () => taskState.status,
      pause: () => {
        if (taskState.status === TaskStatus.RUNNING) {
          taskState.status = TaskStatus.PAUSED;
        }
        return taskState.status;
      },
      resume: () => {
        if (taskState.status === TaskStatus.PAUSED) {
          taskState.status = TaskStatus.RUNNING;
        }
        return taskState.status;
      },
      cancel: () => {
        if (taskState.status !== TaskStatus.COMPLETED) {
          taskState.status = TaskStatus.CANCELLED;
        }
        return taskState.status;
      },
      emitter: this.errorEmitter,
    };
  }

  /**
   * Execute a task asynchronously and return a Task control object
   * @param task The task to execute
   * @param params Optional parameters for the task
   * @param initPage Optional page to use for the task
   * @returns A promise that resolves to a Task control object for managing the running task
   */
  public async executeTaskAsync(
    task: string,
    params?: TaskParams,
    initPage?: Page
  ): Promise<Task> {
    const taskId = uuidv4();
    let activeTaskPage = initPage || (await this.getCurrentPage());

    // Follow new tabs opened by the current active page
    const onPage = async (newPage: Page) => {
      try {
        const opener = await newPage.opener();
        if (opener === activeTaskPage) {
          if (this.debug) {
            console.log(
              `[HyperAgent] Task following new tab: ${newPage.url()}`
            );
          }
          activeTaskPage = newPage;
        }
      } catch {
        // Ignore
      }
    };
    this.context?.on("page", onPage);
    const cleanup = () => this.context?.off("page", onPage);

    const taskState: TaskState = {
      id: taskId,
      task: task,
      status: TaskStatus.PENDING,
      startingPage: activeTaskPage,
      steps: [],
    };
    this.tasks[taskId] = taskState;
    const mergedParams = params ?? {};
    const opType: OperationType = mergedParams.outputSchema ? "extract" : "act";
    const selectorWarnings: string[] = [];
    runAgentTask(
      {
        llm: this.llm,
        actions: this.getActions(mergedParams.outputSchema),
        tokenLimit: this.tokenLimit,
        debug: this.debug,
        mcpClient: this.mcpClient,
        variables: this._variables,
        cdpActions: this.cdpActionsEnabled,
        activePage: async () => activeTaskPage,
        opType,
        selectorWarnings,
        recordLLMUsage: this.recordLLMUsage.bind(this),
      },
      taskState,
      mergedParams
    )
      .then(() => cleanup())
      .catch((error: Error) => {
        cleanup();
        // Retrieve the correct state to update
        const failedTaskState = this.tasks[taskId];
      if (failedTaskState) {
        failedTaskState.status = TaskStatus.FAILED;
        failedTaskState.error = error.message;
        // Emit error on the central emitter, including the taskId
        this.errorEmitter.emit("error", error);
      } else {
        // Fallback if task state somehow doesn't exist
        console.error(`Task state ${taskId} not found during error handling.`);
      }
    });
    return this.getTaskControl(taskId);
  }

  /**
   * Execute a task and wait for completion
   * @param task The task to execute
   * @param params Optional parameters for the task
   * @param initPage Optional page to use for the task
   * @returns A promise that resolves to the task output
   */
  public async executeTask(
    task: string,
    params?: TaskParams,
    initPage?: Page
  ): Promise<TaskOutput> {
    const taskId = uuidv4();
    let activeTaskPage = initPage || (await this.getCurrentPage());

    // Follow new tabs opened by the current active page
    const onPage = async (newPage: Page) => {
      try {
        const opener = await newPage.opener();
        if (opener === activeTaskPage) {
          if (this.debug) {
            console.log(
              `[HyperAgent] Task following new tab: ${newPage.url()}`
            );
          }
          activeTaskPage = newPage;
        }
      } catch {
        // Ignore
      }
    };
    this.context?.on("page", onPage);

    const taskState: TaskState = {
      id: taskId,
      task: task,
      status: TaskStatus.PENDING,
      startingPage: activeTaskPage,
      steps: [],
    };
    this.tasks[taskId] = taskState;
    const mergedParams = params ?? {};
    const opType: OperationType = mergedParams?.outputSchema ? "extract" : "act";
    const selectorWarnings: string[] = [];
    const metricsBefore = this.metricsTracker.snapshot();
    const opStart = performance.now();
    try {

      const cachePrep = await this.prepareCache<TaskOutput>(activeTaskPage, {
        opType,
        instruction: task,
        selector: mergedParams.selector,
        outputSchema: mergedParams.outputSchema,
        params: mergedParams,
      });

      if (
        cachePrep?.warning &&
        !selectorWarnings.includes(cachePrep.warning)
      ) {
        selectorWarnings.push(cachePrep.warning);
      }

      if (cachePrep?.hit) {
        this.context?.off("page", onPage);
        taskState.status = TaskStatus.COMPLETED;
        taskState.output = cachePrep.hit.output;
        taskState.steps = cachePrep.hit.steps ?? [];
        const metricsAfter = this.metricsTracker.snapshot();
        const delta = this.computeOpDelta(opType, metricsBefore, metricsAfter);
        const duration = performance.now() - opStart;
        const warningText =
          selectorWarnings.length > 0
            ? selectorWarnings.join(" | ")
            : cachePrep.warning;
        this.pushHistoryEntry({
          id: taskId,
          ts: Date.now(),
          opType,
          url: page.url(),
          instruction: task,
          selector: mergedParams.selector,
          model: this.llm.getModelId?.() ?? "unknown-model",
          durationMs: Math.round(duration),
          promptTokens: delta.promptTokens,
          completionTokens: delta.completionTokens,
          cacheHit: true,
          warning: warningText,
        });
        return cachePrep.hit;
      }

      const taskStart = performance.now();
      const result = await runAgentTask(
        {
          llm: this.llm,
          actions: this.getActions(mergedParams?.outputSchema),
          tokenLimit: this.tokenLimit,
          debug: this.debug,
          mcpClient: this.mcpClient,
          variables: this._variables,
          cdpActions: this.cdpActionsEnabled,
          activePage: async () => activeTaskPage,
          initialDomState: cachePrep?.domState,
          opType,
          selectorWarnings,
          recordLLMUsage: this.recordLLMUsage.bind(this),
        },
        taskState,
        mergedParams
      );
      this.context?.off("page", onPage);
      const duration = performance.now() - taskStart;
      const metricsAfter = this.metricsTracker.snapshot();
      const delta = this.computeOpDelta(opType, metricsBefore, metricsAfter);
      const opDuration = performance.now() - opStart;
      if (cachePrep && result.status === TaskStatus.COMPLETED) {
        cachePrep.write(result, Math.round(duration), {
          promptTokens: delta.promptTokens,
          completionTokens: delta.completionTokens,
        });
      }
      const warningText =
        selectorWarnings.length > 0 ? selectorWarnings.join(" | ") : undefined;
      this.pushHistoryEntry({
        id: taskId,
        ts: Date.now(),
        opType,
        url: page.url(),
        instruction: task,
        selector: mergedParams.selector,
        model: this.llm.getModelId?.() ?? "unknown-model",
        durationMs: Math.round(opDuration),
        promptTokens: delta.promptTokens,
        completionTokens: delta.completionTokens,
        cacheHit: false,
        warning: warningText,
      });
      return result;
    } catch (error) {
      this.context?.off("page", onPage);
      taskState.status = TaskStatus.FAILED;
      const metricsAfter = this.metricsTracker.snapshot();
      const delta = this.computeOpDelta(opType, metricsBefore, metricsAfter);
      const opDuration = performance.now() - opStart;
      const warningText =
        selectorWarnings.length > 0 ? selectorWarnings.join(" | ") : undefined;
      this.pushHistoryEntry({
        id: taskId,
        ts: Date.now(),
        opType,
        url: page.url(),
        instruction: task,
        selector: mergedParams.selector,
        model: this.llm.getModelId?.() ?? "unknown-model",
        durationMs: Math.round(opDuration),
        promptTokens: delta.promptTokens,
        completionTokens: delta.completionTokens,
        cacheHit: false,
        warning: warningText,
        error: error instanceof Error ? error.message : String(error),
      });
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (error instanceof HyperAgentError) {
        throw error;
      }
      throw this.toOperationError(opType, errorMsg, page, task, error);
    }
  }

  /**
   * Find element with retry logic
   * Retries element finding with DOM refetch until element is found or max retries reached
   *
   * @param instruction Natural language instruction for the action
   * @param page The page to search on
   * @param maxRetries Maximum number of retry attempts
   * @param retryDelayMs Delay between retries in milliseconds
   * @returns Object containing the found element, DOM state, and element map
   * @throws Error if element is not found after all retries
   */
  private async findElementWithRetry(
    instruction: string,
    page: Page,
    maxRetries: number,
    retryDelayMs: number,
    startTime: string,
    initialDomState?: A11yDOMState
  ): Promise<{
    element: ExamineDomResult;
    domState: A11yDOMState;
    elementMap: Map<string, AccessibilityNode>;
    llmResponse: {
      rawText: string;
      parsed: unknown;
      usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number };
    };
    llmDurationMs?: number;
    messages?: HyperAgentMessage[];
  }> {
    // Delegate to shared utility
    const result = await findElementWithInstruction(
      instruction,
      page,
      this.llm,
      {
        maxRetries,
        retryDelayMs,
        debug: this.debug,
        initialDomState,
      }
    );
    this.recordLLMUsage("act", {
      usage: result.llmResponse?.usage,
      durationMs: result.llmDurationMs,
      prompt: result.messages,
      response: result.llmResponse?.rawText,
      url: page.url(),
      instruction,
    });

    // Check if element was found
    if (result.success && result.element) {
      // Success - return the result
      return {
        element: result.element,
        domState: result.domState,
        elementMap: result.elementMap,
        llmResponse: result.llmResponse!,
        llmDurationMs: result.llmDurationMs,
        messages: result.messages,
      };
    }

    // Element not found after all retries - handle error case
    if (this.debug) {
      console.error(
        `[aiAction] No elements found for instruction: "${instruction}" after ${maxRetries} attempts`
      );
      console.error(`[aiAction] Current URL: ${page.url()}`);
      console.error(
        `[aiAction] Total elements in final a11y tree: ${result.domState.elements.size}`
      );

      // Write debug data to files before throwing error
      await this.writeDebugData({
        instruction,
        page,
        startTime,
        domState: result.domState,
        elementMap: result.elementMap,
        llmResponse: result.llmResponse,
        error: new HyperagentError(
          `No elements found for instruction: "${instruction}" after ${maxRetries} retry attempts.`,
          404
        ),
        success: false,
      });
    }

    throw new HyperagentError(
      `No elements found for instruction: "${instruction}" after ${maxRetries} retry attempts. The instruction may be too vague, the element may not exist, or the page may not have fully loaded.`,
      404
    );
  }

  private async writeDebugData(params: {
    instruction: string;
    page: Page;
    startTime: string;
    domState: Awaited<
      ReturnType<typeof import("../context-providers/a11y-dom").getA11yDOM>
    > | null;
    elementMap: Map<string, AccessibilityNode> | null;
    element?: {
      elementId: string;
      method: string;
      arguments: unknown[];
      xpath?: string;
    };
    llmResponse?: {
      rawText: string;
      parsed: unknown;
    };
    error?: unknown;
    success: boolean;
  }): Promise<void> {
    if (!this.debug || !params.domState || !params.elementMap) {
      return;
    }

    const { writeAiActionDebug } = await import("../utils/debugWriter");

    try {
      const screenshot = await params.page
        .screenshot({ type: "png" })
        .catch(() => null);

      if (params.success && params.element) {
        // Success case - write found element data
        await writeAiActionDebug({
          instruction: params.instruction,
          url: params.page.url(),
          timestamp: params.startTime,
          domElementCount: params.domState.elements.size,
          domTree: params.domState.domState,
          screenshot: screenshot || undefined,
          foundElement: {
            elementId: params.element.elementId,
            method: params.element.method,
            arguments: params.element.arguments,
            xpath: params.element.xpath,
          },
          llmResponse: params.llmResponse,
          success: true,
          frameDebugInfo: params.domState.frameDebugInfo,
        });
      } else {
        // Error case - write available elements
        const availableElements = this.collectInteractiveElements(
          params.elementMap,
          HyperAgent.AIACTION_CONFIG.MAX_DEBUG_ELEMENTS_TO_STORE
        );

        await writeAiActionDebug({
          instruction: params.instruction,
          url: params.page.url(),
          timestamp: params.startTime,
          domElementCount: params.domState.elements.size,
          domTree: params.domState.domState,
          screenshot: screenshot || undefined,
          availableElements,
          llmResponse: params.llmResponse,
          error: {
            message:
              params.error instanceof Error
                ? params.error.message
                : String(params.error),
            stack:
              params.error instanceof Error ? params.error.stack : undefined,
          },
          success: false,
          frameDebugInfo: params.domState.frameDebugInfo,
        });
      }
    } catch (debugError) {
      console.error(`[aiAction] Failed to write debug data:`, debugError);
    }
  }

  /**
   * Collect interactive elements from element map for debugging
   * Extracts elements with interactive roles (button, link, textbox, etc.)
   *
   * @param elementMap Map of element IDs to element data
   * @param limit Maximum number of elements to collect
   * @returns Array of interactive elements with id, role, and label
   */
  private collectInteractiveElements(
    elementMap: Map<string, AccessibilityNode>,
    limit: number = 20
  ): Array<{ id: string; role: string; label: string }> {
    // Group elements by frame
    const frameElements = new Map<
      string,
      Array<{ id: string; role: string; label: string }>
    >();

    for (const [id, elem] of elementMap) {
      const role = elem.role;

      if (
        role &&
        [
          "button",
          "link",
          "textbox",
          "searchbox",
          "combobox",
          "checkbox",
          "tab",
          "menuitem",
        ].includes(role)
      ) {
        const label = elem.name || elem.description || elem.value || "";

        if (label) {
          // Extract frame index from ID (format: "frameIndex-backendNodeId")
          const frameIndex = id.split("-")[0];

          if (!frameElements.has(frameIndex)) {
            frameElements.set(frameIndex, []);
          }

          frameElements.get(frameIndex)!.push({ id, role, label });
        }
      }
    }

    // Collect elements: prioritize iframe content, then main frame
    const result: Array<{ id: string; role: string; label: string }> = [];

    // First, collect ALL iframe elements (non-0 frames)
    for (const [frameIndex, elements] of frameElements) {
      if (frameIndex !== "0") {
        result.push(...elements);
      }
    }

    // Then, fill remaining slots with main frame elements
    const mainFrameElements = frameElements.get("0") || [];
    const remainingSlots = limit - result.length;
    if (remainingSlots > 0) {
      result.push(...mainFrameElements.slice(0, remainingSlots));
    }

    return result.slice(0, limit);
  }

  /**
   * Execute a single granular action using a11y mode
   * Internal method used by page.aiAction()
   *
   * Architecture: Simple examine->act flow
   * - 1 LLM call (examineDom finds element and suggests method)
   * - Direct execution (no agent loop)
   *
   * @param instruction Natural language instruction for a single action
   * @param page The page to execute the action on
   * @returns A promise that resolves to the task output
   */
  private async executeSingleAction(
    instruction: string,
    pageOrGetter: Page | (() => Page),
    _params?: TaskParams
  ): Promise<TaskOutput> {
    const opType: OperationType = "act";
    const metricsBefore = this.metricsTracker.snapshot();
    const opStart = performance.now();
    const params = _params ?? {};
    const actionStart = performance.now();
    const startTime = new Date().toISOString();
    if (this.debug) {
      console.log(`[aiAction] Instruction: ${instruction}`);
    }

    const getPage = () =>
      typeof pageOrGetter === "function" ? pageOrGetter() : pageOrGetter;
    const initialPage = getPage();

    const cachePrep = await this.prepareCache<TaskOutput>(initialPage, {
      opType: "act",
      instruction,
      selector: params.selector,
      params,
    });

    if (cachePrep?.hit) {
      const metricsAfter = this.metricsTracker.snapshot();
      const delta = this.computeOpDelta(opType, metricsBefore, metricsAfter);
      const opDuration = performance.now() - opStart;
      const warningText = cachePrep?.warning;
      this.pushHistoryEntry({
        id: uuidv4(),
        ts: Date.now(),
        opType,
        url: page.url(),
        instruction,
        selector: params.selector,
        model: this.llm.getModelId?.() ?? "unknown-model",
        durationMs: Math.round(opDuration),
        promptTokens: delta.promptTokens,
        completionTokens: delta.completionTokens,
        cacheHit: true,
        warning: warningText,
      });
      return cachePrep.hit;
    }

    let domState: A11yDOMState | null = cachePrep?.domState ?? null;
    let elementMap: Map<string, AccessibilityNode> | null = null;

    try {
      // Find element with retry logic
      const findStart = performance.now();
      const {
        element,
        domState: foundDomState,
        elementMap: foundElementMap,
        llmResponse,
      } = await this.findElementWithRetry(
        instruction,
        initialPage,
        HyperAgent.AIACTION_CONFIG.MAX_RETRIES,
        HyperAgent.AIACTION_CONFIG.RETRY_DELAY_MS,
        startTime,
        domState ?? undefined
      );

      // Check if page context switched during findElement (e.g. new tab opened by previous action)
      if (getPage() !== initialPage) {
        throw new HyperagentError("Page context switched during execution", 409);
      }

      domState = foundDomState;
      elementMap = foundElementMap;
      logPerf(
        this.debug,
        "[Perf][executeSingleAction] findElementWithRetry",
        findStart
      );

      if (this.debug) {
        console.log(`[aiAction] Found element: ${element.elementId}`);
        console.log(`[aiAction] Method: ${element.method}`);
        console.log(`[aiAction] Arguments:`, element.arguments);
      }

      if (!element.method) {
        throw new HyperagentError(
          "Element method is missing from LLM response",
          500
        );
      }
      const method = element.method;
      const args = element.arguments || [];
      if (!isEncodedId(element.elementId)) {
        throw new HyperagentError(
          `Element ID "${element.elementId}" is not in encoded format (frameIndex-backendNodeId).`,
          400
        );
      }
      let actionXPath: string | undefined;

      // Use shared runtime context
      const { cdpClient, frameContextManager } = await initializeRuntimeContext(
        initialPage,
        this.debug
      );

      // Check context switch again before action
      if (getPage() !== initialPage) {
        throw new HyperagentError("Page context switched during execution", 409);
      }

      // Create a context object compatible with performAction
      // We need to mock the ActionContext shape since performAction expects it
      // but we don't have a full AgentCtx/TaskState here
      const actionContext: ActionContext = {
        domState,
        page: initialPage,
        tokenLimit: this.tokenLimit,
        llm: this.llm,
        debug: this.debug,
        // Only provide CDP if enabled
        cdpActions: this.cdpActionsEnabled,
        cdp: this.cdpActionsEnabled
          ? {
              client: cdpClient,
              frameContextManager,
              resolveElement: resolveElement,
              dispatchCDPAction: dispatchCDPAction,
              preferScriptBoundingBox: this.debug,
              debug: this.debug,
            }
          : undefined,
        // These are required by ActionContext but not used by performAction
        debugDir: undefined,
        mcpClient: this.mcpClient,
        variables: Object.values(this._variables),
        invalidateDomCache: () => markDomSnapshotDirty(initialPage),
      };

      // Use shared performAction to execute
      const actionOutput = await performAction(actionContext, {
        elementId: element.elementId,
        method,
        arguments: args,
        instruction,
        confidence: 1, // Implicit confidence for single action
      });

      if (
        actionOutput.debug &&
        typeof actionOutput.debug === "object" &&
        "requestedAction" in actionOutput.debug
      ) {
        actionXPath = (actionOutput.debug as any).elementMetadata?.xpath;
      }

      if (!actionOutput.success) {
        throw new Error(actionOutput.message);
      }

      // Wait for DOM to settle after action
      const waitStart = performance.now();
      await waitForSettledDOM(initialPage);
      markDomSnapshotDirty(initialPage);
      logPerf(
        this.debug,
        "[Perf][executeSingleAction] action execution",
        actionStart
      );
      logPerf(
        this.debug,
        "[Perf][executeSingleAction] waitForSettledDOM",
        waitStart
      );

      // Write debug data on success
      await this.writeDebugData({
        instruction,
        page: initialPage,
        startTime,
        domState,
        elementMap,
        element: {
          elementId: element.elementId,
          method,
          arguments: args,
          xpath: actionXPath,
        },
        llmResponse,
        success: true,
      });

      const metricsAfter = this.metricsTracker.snapshot();
      const delta = this.computeOpDelta(opType, metricsBefore, metricsAfter);
      const opDuration = performance.now() - opStart;
      if (cachePrep) {
        cachePrep.write(
          {
            status: TaskStatus.COMPLETED,
            steps: [],
            output: `Successfully executed: ${instruction}`,
          },
          Math.round(performance.now() - actionStart),
          {
            promptTokens: delta.promptTokens,
            completionTokens: delta.completionTokens,
          }
        );
      }
      const warningText = cachePrep?.warning;
      this.pushHistoryEntry({
        id: uuidv4(),
        ts: Date.now(),
        opType,
        url: page.url(),
        instruction,
        selector: params.selector,
        model: this.llm.getModelId?.() ?? "unknown-model",
        durationMs: Math.round(opDuration),
        promptTokens: delta.promptTokens,
        completionTokens: delta.completionTokens,
        cacheHit: false,
        warning: warningText,
      });

      logPerf(this.debug, "[Perf][executeSingleAction] total", actionStart);
      return {
        status: TaskStatus.COMPLETED,
        steps: [],
        output: `Successfully executed: ${instruction}`,
      };
    } catch (error) {
      // If page switched during execution, prioritize that over the error
      // This catches cases where findElement failed because the old page closed/navigated
      if (getPage() !== initialPage) {
        throw new HyperagentError("Page context switched during execution", 409);
      }

      // Write debug data on error
      await this.writeDebugData({
        instruction,
        page: initialPage,
        startTime,
        domState,
        elementMap,
        error,
        success: false,
      });

      const metricsAfter = this.metricsTracker.snapshot();
      const delta = this.computeOpDelta(opType, metricsBefore, metricsAfter);
      const opDuration = performance.now() - opStart;
      const errorMsg = error instanceof Error ? error.message : String(error);
      const warningText = cachePrep?.warning;
      this.pushHistoryEntry({
        id: uuidv4(),
        ts: Date.now(),
        opType,
        url: page.url(),
        instruction,
        selector: params.selector,
        model: this.llm.getModelId?.() ?? "unknown-model",
        durationMs: Math.round(opDuration),
        promptTokens: delta.promptTokens,
        completionTokens: delta.completionTokens,
        cacheHit: false,
        warning: warningText,
        error: errorMsg,
      });

      // Re-throw HyperagentErrors as-is
      if (error instanceof HyperAgentError) {
        throw error;
      }
      // Wrap other errors
      throw this.toOperationError(
        opType,
        `Failed to execute action: ${errorMsg}`,
        page,
        instruction,
        error
      );
    }
  }

  private resolveInferenceLogPath(
    target?: string | true
  ): string | undefined {
    if (!target) return undefined;
    return target === true
      ? path.resolve("debug/llm.log")
      : path.resolve(target);
  }

  private async appendInferenceLog(entry: InferenceLogEntry): Promise<void> {
    if (!this.inferenceLogPath) return;
    try {
      await fs.mkdir(path.dirname(this.inferenceLogPath), { recursive: true });
      await fs.appendFile(
        this.inferenceLogPath,
        `${JSON.stringify(entry)}\n`,
        "utf8"
      );
    } catch (error) {
      if (this.debug) {
        console.warn("[HyperAgent] Failed to write inference log:", error);
      }
    }
  }

  private recordLLMUsage(
    opType: OperationType,
    payload: LLMUsagePayload
  ): void {
    const usage = payload.usage as
      | (TokenUsage & { inputTokens?: number; outputTokens?: number })
      | undefined;
    const promptTokens =
      usage?.promptTokens ?? usage?.inputTokens ?? 0;
    const completionTokens =
      usage?.completionTokens ?? usage?.outputTokens ?? 0;
    const reasoningTokens = usage?.reasoningTokens;
    const durationMs = payload.durationMs ?? 0;

    this.metricsTracker.recordOperation(opType, {
      promptTokens,
      completionTokens,
      reasoningTokens,
      durationMs,
    });

    if (!this.inferenceLogPath) {
      return;
    }

    const entry: InferenceLogEntry = {
      ts: new Date().toISOString(),
      opType,
      model: payload.model ?? this.llm.getModelId?.() ?? "unknown-model",
      cacheHit: payload.cacheHit ?? false,
      prompt: payload.prompt ?? [],
      response: payload.response ?? "",
      promptTokens,
      completionTokens,
      reasoningTokens,
      durationMs,
      url: payload.url,
      instruction: payload.instruction,
      selector: payload.selector,
    };

    void this.appendInferenceLog(entry);
  }

  private computeOpDelta(
    opType: OperationType,
    before: HyperMetrics,
    after: HyperMetrics
  ): { promptTokens: number; completionTokens: number; durationMs: number } {
    const beforeOp = before.byOp[opType];
    const afterOp = after.byOp[opType];
    return {
      promptTokens: afterOp.promptTokens - beforeOp.promptTokens,
      completionTokens: afterOp.completionTokens - beforeOp.completionTokens,
      durationMs: afterOp.durationMs - beforeOp.durationMs,
    };
  }

  private pushHistoryEntry(entry: AgentHistoryEntry): void {
    this.historyBuffer.add(entry);
  }

  private toOperationError(
    opType: OperationType,
    message: string,
    page: Page,
    instruction: string,
    cause?: unknown
  ): HyperAgentError {
    const context = {
      opType,
      url: page.url(),
      instruction,
      cause,
    };
    if (opType === "extract") {
      return new HyperAgentExtractError(message, context);
    }
    if (opType === "observe") {
      return new HyperAgentObserveError(message, context);
    }
    return new HyperAgentActError(message, context);
  }

  private computeSchemaHash(schema?: z.ZodTypeAny): string | undefined {
    if (!schema) return undefined;
    try {
      const schemaJson = zodToJsonSchema(schema);
      return sha256(stableStringify(schemaJson));
    } catch {
      return undefined;
    }
  }

  private async prepareCache<Result>(
    page: Page,
    options: {
      opType: OperationType;
      instruction: string;
      selector?: string;
      outputSchema?: z.ZodTypeAny;
      params?: TaskParams;
    }
  ): Promise<CachePreparation<Result> | null> {
    if (!this.cacheManager.isEnabled()) {
      return null;
    }

    const useDomCache = options.params?.useDomCache === true;
    const enableStreaming = options.params?.enableDomStreaming === true;
    const enableVisualMode = options.params?.enableVisualMode ?? false;

    const domState = await captureDOMState(page, {
      debug: this.debug,
      useCache: useDomCache,
      enableVisualMode,
      enableStreaming,
    }).catch(() => null);

    if (!domState) {
      return null;
    }

    let workingDomState = domState;
    let warning: string | undefined;

    if (options.selector && options.opType === "extract") {
      const scoped = await scopeDomWithSelector(
        page,
        domState,
        options.selector,
        options.params?.selectorType
      );
      workingDomState = scoped.domState;
      warning = scoped.warning;
    }

    const domHash = await computeDomHash(page, workingDomState.domState);
    if (!domHash) {
      return null;
    }

    const keyParts: CacheKeyParts = {
      opType: options.opType,
      url: page.url(),
      instruction: options.instruction,
      selector: options.selector,
      schemaHash: this.computeSchemaHash(options.outputSchema),
      domHash,
    };

    const cached = await this.cacheManager.read<Result>(keyParts);
    if (cached) {
      this.metricsTracker.recordCacheHit();
      return {
        hit: cached.result,
        domHash,
        warning,
        write: () => {},
      };
    }

    this.metricsTracker.recordCacheMiss();

    return {
      domState: workingDomState,
      domHash,
      keyParts,
      warning,
      write: (result, durationMs, tokens) => {
        this.metricsTracker.recordCacheWrite();
        this.cacheManager.write({
          ...keyParts,
          result,
          createdAt: new Date().toISOString(),
          durationMs,
          model: this.llm.getModelId?.() ?? "unknown-model",
          promptTokens: tokens?.promptTokens,
          completionTokens: tokens?.completionTokens,
        });
      },
    };
  }

  /**
   * Register a new action with the agent
   * @param action The action to register
   */
  private async registerAction(action: AgentActionDefinition) {
    if (action.type === "complete") {
      throw new HyperagentError(
        "Could not add an action with the name 'complete'. Complete is a reserved action.",
        400
      );
    }
    const actionsList = new Set(
      this.actions.map((registeredAction) => registeredAction.type)
    );
    if (actionsList.has(action.type)) {
      throw new Error(
        `Could not register action of type ${action.type}. Action with the same name is already registered`
      );
    } else {
      this.actions.push(action);
    }
  }

  /**
   * Initialize the MCP client with the given configuration
   * @param config The MCP configuration
   */
  public async initializeMCPClient(config: MCPConfig): Promise<void> {
    if (!config || config.servers.length === 0) {
      return;
    }
    this.mcpClient = new MCPClient(this.debug);
    try {
      for (const serverConfig of config.servers) {
        try {
          const { serverId, actions } =
            await this.mcpClient.connectToServer(serverConfig);
          for (const action of actions) {
            this.registerAction(action);
          }
          if (this.debug) {
            console.log(`MCP server ${serverId} initialized successfully`);
          }
        } catch (error) {
          console.error(
            `Failed to initialize MCP server ${serverConfig.id || "unknown"}:`,
            error
          );
        }
      }

      const serverIds = this.mcpClient.getServerIds();
      if (this.debug) {
        console.log(
          `Successfully connected to ${serverIds.length} MCP servers`
        );
      }
    } catch (error) {
      console.error("Failed to initialize MCP client:", error);
      this.mcpClient = undefined;
    }
  }

  /**
   * Connect to an MCP server at runtime
   * @param serverConfig Configuration for the MCP server
   * @returns Server ID if connection was successful
   */
  public async connectToMCPServer(
    serverConfig: MCPServerConfig
  ): Promise<string | null> {
    if (!this.mcpClient) {
      this.mcpClient = new MCPClient(this.debug);
    }

    try {
      const { serverId, actions } =
        await this.mcpClient.connectToServer(serverConfig);

      // Register the actions from this server
      for (const action of actions) {
        this.registerAction(action);
      }

      if (this.debug) {
        console.log(`Connected to MCP server with ID: ${serverId}`);
      }
      return serverId;
    } catch (error) {
      console.error(`Failed to connect to MCP server:`, error);
      return null;
    }
  }

  /**
   * Disconnect from a specific MCP server
   * @param serverId ID of the server to disconnect from
   * @returns Boolean indicating if the disconnection was successful
   */
  public disconnectFromMCPServer(serverId: string): boolean {
    if (!this.mcpClient) {
      return false;
    }

    try {
      this.mcpClient.disconnectServer(serverId);
      return true;
    } catch (error) {
      console.error(`Failed to disconnect from MCP server ${serverId}:`, error);
      return false;
    }
  }

  /**
   * Check if a specific MCP server is connected
   * @param serverId ID of the server to check
   * @returns Boolean indicating if the server is connected
   */
  public isMCPServerConnected(serverId: string): boolean {
    if (!this.mcpClient) {
      return false;
    }
    return this.mcpClient.getServerIds().includes(serverId);
  }

  /**
   * Get all connected MCP server IDs
   * @returns Array of server IDs
   */
  public getMCPServerIds(): string[] {
    if (!this.mcpClient) {
      return [];
    }
    return this.mcpClient.getServerIds();
  }

  /**
   * Get information about all connected MCP servers
   * @returns Array of server information objects or null if no MCP client is initialized
   */
  public getMCPServerInfo(): Array<{
    id: string;
    toolCount: number;
    toolNames: string[];
  }> | null {
    if (!this.mcpClient) {
      return null;
    }
    return this.mcpClient.getServerInfo();
  }

  /**
   * Pretty print an action
   * @param action The action to print
   * @returns Formatted string representation of the action
   */
  public pprintAction(action: ActionType): string {
    const foundAction = this.actions.find(
      (actions) => actions.type === action.type
    );
    if (foundAction && foundAction.pprintAction) {
      return foundAction.pprintAction(action.params);
    }
    return "";
  }

  public getSession() {
    const session = this.browserProvider.getSession();
    if (!session) {
      return null;
    }
    return session;
  }

  private setupHyperPage(page: Page): HyperPage {
    const hyperPage = page as HyperPage;

    // Clean up existing listener if this page was already setup
    if ((hyperPage as any)._scopeListenerCleanup) {
      (hyperPage as any)._scopeListenerCleanup();
    }

    // History Stack: [Root, Tab1, Tab2, ...]
    const pageStack: Page[] = [page];
    const getActivePage = () => pageStack[pageStack.length - 1];

    // Handle tab closing (Pop)
    const handleClose = (p: Page) => {
      const idx = pageStack.indexOf(p);
      if (idx !== -1) {
        if (this.debug) {
          console.log(`[HyperPage] Tab closed, removing from stack`);
        }
        pageStack.splice(idx, 1);
      }
    };
    // Listen for close on the root page
    page.on("close", () => handleClose(page));

    // Handle new tabs (Push)
    const onPage = async (newPage: Page) => {
      try {
        // Check if the new page is opened by our current active scope page
        const opener = await newPage.opener();
        if (opener === getActivePage()) {
          if (this.debug) {
            console.log(
              `[HyperPage] Auto-switching to new tab (Push): ${newPage.url()}`
            );
          }
          // Update the scope to follow the new tab
          pageStack.push(newPage);
          // Listen for close on the new page
          newPage.on("close", () => handleClose(newPage));
        }
      } catch {
        // Ignore
      }
    };

    // Attach a persistent listener to track page flow for the lifetime of this wrapper
    page.context().on("page", onPage);
    (hyperPage as any)._scopeListenerCleanup = () => {
      page.context().off("page", onPage);
    };

    hyperPage.ai = (task: string, params?: TaskParams) =>
      this.executeTask(task, params, getActivePage());

    hyperPage.aiAction = async (instruction: string, params?: TaskParams) => {
      const maxRetries = 3;
      for (let i = 0; i < maxRetries; i++) {
        try {
          return await this.executeSingleAction(
            instruction,
            getActivePage,
            params
          );
        } catch (err: any) {
          if (
            err.statusCode === 409 ||
            (err.message && err.message.includes("Page context switched"))
          ) {
            if (this.debug) {
              console.log(
                "[HyperPage] Action aborted due to tab switch, retrying on new page..."
              );
            }
            // Wait briefly for stability
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
          throw err;
        }
      }
      throw new HyperagentError(
        "Failed to execute action after max retries due to page switching",
        500
      );
    };

    // aiAsync tasks run in background, so we just use the current scope start point.
    // The task itself has internal auto-following logic (from executeTaskAsync implementation).
    hyperPage.aiAsync = (task: string, params?: TaskParams) =>
      this.executeTaskAsync(task, params, getActivePage());

    hyperPage.extract = async (task, outputSchema, params) => {
      if (!task && !outputSchema) {
        throw new HyperagentError(
          "No task description or output schema specified",
          400
        );
      }
      const taskParams: TaskParams = {
        maxSteps: params?.maxSteps ?? 2,
        ...params,
        outputSchema,
      };
      if (task) {
        const res = await this.executeTask(
          `You have to perform an extraction on the current page. You have to perform the extraction according to the task: ${task}. Make sure your final response only contains the extracted content`,
          taskParams,
          getActivePage()
        );
        if (outputSchema) {
          const outputText = res.output;
          if (typeof outputText !== "string" || outputText === "") {
            throw new Error(
              `Extract failed: Agent did not complete with output. Task status: ${res.status}. Check debug output for details.`
            );
          }
          return JSON.parse(outputText);
        }
        const outputText = res.output;
        if (typeof outputText !== "string" || outputText === "") {
          throw new Error(
            `Extract failed: Agent did not complete with output. Task status: ${res.status}. Check debug output for details.`
          );
        }
        return outputText;
      } else {
        const res = await this.executeTask(
          "You have to perform a data extraction on the current page. Make sure your final response only contains the extracted content",
          taskParams,
          getActivePage()
        );
        if (typeof res.output !== "string" || res.output === "") {
          throw new Error(
            `Extract failed: Agent did not complete with output. Task status: ${res.status}. Check debug output for details.`
          );
        }
        return JSON.parse(res.output);
      }
    };
    return hyperPage;
  }
}

function logPerf(
  debug: boolean | undefined,
  label: string,
  start: number
): void {
  if (!debug) return;
  const duration = performance.now() - start;
  console.log(`${label} took ${Math.round(duration)}ms`);
}
