import { Browser, BrowserContext, Page } from "playwright-core";
import { v4 as uuidv4 } from "uuid";

import {
  BrowserProviders,
  HyperAgentConfig,
  MCPConfig,
  MCPServerConfig,
} from "@/types/config";
import { HyperAgentLLM, createLLMClient } from "@/llm/providers";
import {
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
  A11yDOMState,
  IframeInfo,
  toEncodedId,
} from "../context-providers/a11y-dom/types";
import { MCPClient } from "./mcp/client";
import { runAgentTask } from "./tools/agent";
import { HyperPage, HyperVariable } from "../types/agent/types";
import { z } from "zod";
import { ErrorEmitter } from "../utils";
import { waitForSettledDOM } from "@/utils/waitForSettledDOM";
import { examineDom } from "./examine-dom";
import { getA11yDOM } from "../context-providers/a11y-dom";
import { ExamineDomResult } from "./examine-dom/types";

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
  private actionConfig: HyperAgentConfig["actionConfig"];

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

  constructor(params: HyperAgentConfig<T> = {}) {
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
    this.actionConfig = params.actionConfig;
    this.errorEmitter = new ErrorEmitter();
  }

  /**
   *  This is just exposed as a utility function. You don't need to call it explicitly.
   * @returns A reference to the current rebrowser-playwright browser instance.
   */
  public async initBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await this.browserProvider.start();
      this.context = await this.browser.newContext({
        viewport: null,
      });

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

      // Listen for new pages (tabs/popups) and automatically switch to them
      this.context.on("page", (newPage) => {
        if (this.debug) {
          console.log("New tab/popup detected, switching focus immediately");
        }

        // Immediately switch to the new page
        // Don't wait for load - Playwright will handle that when actions are performed
        this._currentPage = newPage;

        if (this.debug) {
          console.log(`Now focused on new page (URL will load shortly)`);
        }

        // Set up close handler for this page
        newPage.on("close", () => {
          if (this.debug) {
            console.log("Page closed, switching to another available page");
          }

          // If the closed page was the current page, switch to another
          if (this._currentPage === newPage) {
            const pages = this.context?.pages() || [];
            if (pages.length > 0) {
              this._currentPage = pages[pages.length - 1];
              if (this.debug) {
                console.log(
                  `Switched to page: ${this._currentPage?.url() || "unknown"}`
                );
              }
            } else {
              this._currentPage = null;
            }
          }
        });
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
    const page = initPage || (await this.getCurrentPage());
    const taskState: TaskState = {
      id: taskId,
      task: task,
      status: TaskStatus.PENDING,
      startingPage: page,
      steps: [],
    };
    this.tasks[taskId] = taskState;
    runAgentTask(
      {
        llm: this.llm,
        actions: this.getActions(params?.outputSchema),
        tokenLimit: this.tokenLimit,
        debug: this.debug,
        mcpClient: this.mcpClient,
        variables: this._variables,
        actionConfig: this.actionConfig,
      },
      taskState,
      params
    ).catch((error: Error) => {
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
    const page = initPage || (await this.getCurrentPage());
    const taskState: TaskState = {
      id: taskId,
      task: task,
      status: TaskStatus.PENDING,
      startingPage: page,
      steps: [],
    };
    this.tasks[taskId] = taskState;
    try {
      return await runAgentTask(
        {
          llm: this.llm,
          actions: this.getActions(params?.outputSchema),
          tokenLimit: this.tokenLimit,
          debug: this.debug,
          mcpClient: this.mcpClient,
          variables: this._variables,
          actionConfig: this.actionConfig,
        },
        taskState,
        params
      );
    } catch (error) {
      taskState.status = TaskStatus.FAILED;
      throw error;
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
    startTime: string
  ): Promise<{
    element: ExamineDomResult;
    domState: A11yDOMState;
    elementMap: Map<string, unknown>;
    llmResponse: { rawText: string; parsed: unknown };
  }> {
    let domState: A11yDOMState | null = null;
    let elementMap: Map<string, unknown> | null = null;
    let examineResult: {
      elements: ExamineDomResult[];
      llmResponse: { rawText: string; parsed: unknown };
    } | null = null;

    // Retry loop for element finding
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Wait for DOM to settle (ensures dynamic content like dropdowns have finished loading)
      if (this.debug) {
        if (attempt === 0) {
          console.log(`[aiAction] Waiting for DOM to settle...`);
        } else {
          console.log(
            `[aiAction] Retry ${attempt + 1}/${maxRetries}: Waiting for DOM to settle...`
          );
        }
      }
      await waitForSettledDOM(page);
      if (this.debug) {
        console.log(`[aiAction] DOM settled`);
      }

      // Fetch a11y tree (pass debug flag to avoid expensive debug info collection when not needed)
      domState = await getA11yDOM(page, this.debug);

      if (!domState) {
        throw new Error("Failed to fetch page structure");
      }

      if (this.debug) {
        console.log(
          `[aiAction] Fetched a11y tree: ${domState.elements.size} elements`
        );
      }

      // Convert elements map to string-only keys for examineDom
      elementMap = new Map(
        Array.from(domState.elements).map(([k, v]) => [String(k), v])
      );

      if (this.debug) {
        console.log(
          `[aiAction] Calling examineDom to find element for: "${instruction}"`
        );
      }

      examineResult = await examineDom(
        instruction,
        {
          tree: domState.domState,
          xpathMap: domState.xpathMap || {},
          elements: elementMap,
          url: page.url(),
        },
        this.llm
      );

      // Check if element was found
      if (examineResult && examineResult.elements.length > 0) {
        // Found it! Break out of retry loop
        if (this.debug && attempt > 0) {
          console.log(`[aiAction] Element found on attempt ${attempt + 1}`);
        }
        return {
          element: examineResult.elements[0],
          domState,
          elementMap,
          llmResponse: examineResult.llmResponse,
        };
      }

      // Element not found - retry or fail
      if (attempt < maxRetries - 1) {
        if (this.debug) {
          console.log(
            `[aiAction] Element not found, retrying in ${retryDelayMs}ms (attempt ${attempt + 1}/${maxRetries})...`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }

    // After all retries, throw error with debug info
    if (this.debug && domState && elementMap) {
      console.error(
        `[aiAction] No elements found for instruction: "${instruction}" after ${maxRetries} attempts`
      );
      console.error(`[aiAction] Current URL: ${page.url()}`);
      console.error(
        `[aiAction] Total elements in final a11y tree: ${domState.elements.size}`
      );

      // Show a sample of available interactive elements
      const elements = this.collectInteractiveElements(
        elementMap,
        HyperAgent.AIACTION_CONFIG.MAX_DEBUG_ELEMENTS_TO_DISPLAY
      );
      const MAX_LABEL_LENGTH = HyperAgent.AIACTION_CONFIG.MAX_LABEL_LENGTH;
      const interactiveElements = elements.map(
        ({ id, role, label }) =>
          `  - ${role}: "${label.slice(0, MAX_LABEL_LENGTH)}${label.length > MAX_LABEL_LENGTH ? "..." : ""}" [${id}]`
      );

      if (interactiveElements.length > 0) {
        console.error(
          `[aiAction] Available interactive elements (first ${interactiveElements.length}):`
        );
        console.error(interactiveElements.join("\n"));
        console.error(
          `[aiAction] Try using one of the exact labels above in your instruction`
        );
      } else {
        console.error(`[aiAction] No interactive elements found in a11y tree`);
        console.error(
          `[aiAction] The page may not have fully loaded, or the element might be in an iframe`
        );
      }

      // Write debug data to files before throwing error
      await this.writeDebugData({
        instruction,
        page,
        startTime,
        domState,
        elementMap,
        llmResponse: examineResult?.llmResponse,
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

  /**
   * Write debug data for aiAction execution
   * Captures screenshot, DOM state, and execution details for debugging
   *
   * @param params Debug data parameters
   * @returns Promise that resolves when debug data is written
   */
  private async writeDebugData(params: {
    instruction: string;
    page: Page;
    startTime: string;
    domState: Awaited<
      ReturnType<typeof import("../context-providers/a11y-dom").getA11yDOM>
    > | null;
    elementMap: Map<string, unknown> | null;
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
   * Execute a Playwright method on a locator
   * Handles all supported action types (click, fill, scroll, etc.)
   *
   * @param method The Playwright method to execute
   * @param args Arguments for the method
   * @param locator The Playwright locator to execute on
   * @returns Promise that resolves when action completes
   * @throws Error if method is unknown
   */
  private async executePlaywrightMethod(
    method: string,
    args: unknown[],
    locator: ReturnType<Page["locator"]>
  ): Promise<void> {
    switch (method) {
      case "click":
        await locator.click({
          timeout: HyperAgent.AIACTION_CONFIG.CLICK_TIMEOUT,
        });
        break;
      case "type":
      case "fill":
        await locator.fill((args[0] as string) || "");
        break;
      case "selectOptionFromDropdown":
        await locator.selectOption((args[0] as string) || "");
        break;
      case "hover":
        await locator.hover();
        break;
      case "press":
        await locator.press((args[0] as string) || "Enter");
        break;
      case "check":
        await locator.check();
        break;
      case "uncheck":
        await locator.uncheck();
        break;
      case "scrollTo":
        {
          // Scroll to percentage of element or viewport height
          const scrollArg = (args[0] || "50%").toString();
          await locator.evaluate(
            (element, { yArg }) => {
              function parsePercent(val: string): number {
                const cleaned = val.trim().replace("%", "");
                const num = parseFloat(cleaned);
                return Number.isNaN(num) ? 0 : Math.max(0, Math.min(num, 100));
              }

              const yPct = parsePercent(yArg);

              if (element.tagName.toLowerCase() === "html") {
                const scrollHeight = document.body.scrollHeight;
                const viewportHeight = window.innerHeight;
                const scrollTop =
                  (scrollHeight - viewportHeight) * (yPct / 100);
                window.scrollTo({
                  top: scrollTop,
                  left: window.scrollX,
                  behavior: "smooth",
                });
              } else {
                // Check if element is scrollable
                const scrollHeight = element.scrollHeight;
                const clientHeight = element.clientHeight;
                const isScrollable = scrollHeight > clientHeight;

                if (isScrollable) {
                  // Element has scrollable content - scroll within it
                  const scrollTop =
                    (scrollHeight - clientHeight) * (yPct / 100);
                  element.scrollTo({
                    top: scrollTop,
                    left: element.scrollLeft,
                    behavior: "smooth",
                  });
                } else {
                  // Element is not scrollable (e.g., iframe) - scroll it into view
                  element.scrollIntoView({
                    behavior: "smooth",
                    block: yPct < 30 ? "start" : yPct > 70 ? "end" : "center",
                  });
                }
              }
            },
            { yArg: scrollArg }
          );
        }
        break;
      case "nextChunk":
        // Scroll by one viewport/element height
        await locator.evaluate((element) => {
          const waitForScrollEnd = (el: HTMLElement | Element) =>
            new Promise<void>((resolve) => {
              let last = el.scrollTop ?? 0;
              const check = () => {
                const cur = el.scrollTop ?? 0;
                if (cur === last) return resolve();
                last = cur;
                requestAnimationFrame(check);
              };
              requestAnimationFrame(check);
            });

          const tagName = element.tagName.toLowerCase();

          if (tagName === "html" || tagName === "body") {
            const height = window.visualViewport?.height ?? window.innerHeight;
            window.scrollBy({ top: height, left: 0, behavior: "smooth" });
            const scrollingRoot = (document.scrollingElement ??
              document.documentElement) as HTMLElement;
            return waitForScrollEnd(scrollingRoot);
          }

          const height = (element as HTMLElement).getBoundingClientRect()
            .height;
          (element as HTMLElement).scrollBy({
            top: height,
            left: 0,
            behavior: "smooth",
          });
          return waitForScrollEnd(element);
        });
        break;
      case "prevChunk":
        // Scroll up by one viewport/element height
        await locator.evaluate((element) => {
          const waitForScrollEnd = (el: HTMLElement | Element) =>
            new Promise<void>((resolve) => {
              let last = el.scrollTop ?? 0;
              const check = () => {
                const cur = el.scrollTop ?? 0;
                if (cur === last) return resolve();
                last = cur;
                requestAnimationFrame(check);
              };
              requestAnimationFrame(check);
            });

          const tagName = element.tagName.toLowerCase();

          if (tagName === "html" || tagName === "body") {
            const height = window.visualViewport?.height ?? window.innerHeight;
            window.scrollBy({ top: -height, left: 0, behavior: "smooth" });
            const rootScrollingEl = (document.scrollingElement ??
              document.documentElement) as HTMLElement;
            return waitForScrollEnd(rootScrollingEl);
          }

          const height = (element as HTMLElement).getBoundingClientRect()
            .height;
          (element as HTMLElement).scrollBy({
            top: -height,
            left: 0,
            behavior: "smooth",
          });
          return waitForScrollEnd(element);
        });
        break;
      default: {
        const errorMsg = `Unknown method: ${method}`;
        if (this.debug) {
          console.error(`[aiAction] ${errorMsg}`);
        }
        throw new HyperagentError(errorMsg, 400);
      }
    }

    if (this.debug) {
      console.log(`[aiAction] Successfully executed ${method}`);
    }
  }

  /**
   * Get Playwright locator from element ID
   * Converts element ID to EncodedId, looks up XPath, and creates Playwright locator
   * Supports iframe elements by extracting frameIndex and using frame.locator()
   *
   * @param elementId The element ID to locate
   * @param xpathMap Map of EncodedIds to XPath strings
   * @param page The page to create the locator on
   * @param frameMap Optional map of frame indices to iframe metadata
   * @returns Promise resolving to object with locator and trimmed xpath
   * @throws Error if element ID not found in xpath map
   */
  private async getElementLocator(
    elementId: string,
    xpathMap: Record<string, string>,
    page: Page,
    frameMap?: Map<number, IframeInfo>
  ): Promise<{ locator: ReturnType<Page["locator"]>; xpath: string }> {
    // Convert elementId to EncodedId format for xpath lookup
    const encodedId = toEncodedId(elementId);
    const rawXpath = xpathMap[encodedId];

    if (!rawXpath) {
      const errorMsg = `Element ${elementId} not found in xpath map`;
      if (this.debug) {
        console.error(`[aiAction] ${errorMsg}`);
        console.error(
          `[aiAction] Looking for element with ID: ${elementId} (type: ${typeof elementId})`
        );
        console.error(`[aiAction] Direct lookup result:`, xpathMap[encodedId]);
      }
      throw new HyperagentError(errorMsg, 404);
    }

    // Trim trailing text nodes from xpath
    const xpath = rawXpath.replace(/\/text\(\)(\[\d+\])?$/iu, "");

    // Extract frameIndex from encodedId (format: "frameIndex-nodeIndex")
    const [frameIndexStr] = encodedId.split("-");
    const frameIndex = parseInt(frameIndexStr!, 10);

    // Main frame (frameIndex 0) - use page.locator()
    if (frameIndex === 0) {
      return { locator: page.locator(`xpath=${xpath}`), xpath };
    }

    // Iframe element - need to find the correct frame
    if (!frameMap || !frameMap.has(frameIndex)) {
      const errorMsg = `Frame metadata not found for frame ${frameIndex}`;
      if (this.debug) {
        console.error(`[aiAction] ${errorMsg}`);
      }
      throw new HyperagentError(errorMsg, 404);
    }

    const iframeInfo = frameMap.get(frameIndex)!;

    // Use stored Playwright Frame directly (set during frame matching in getA11yDOM)
    const targetFrame = iframeInfo.playwrightFrame;

    if (!targetFrame) {
      const errorMsg = `Playwright Frame not found for element ${elementId} (frameIndex: ${frameIndex}). Frame matching may have failed.`;
      if (this.debug) {
        console.error(`[aiAction] ${errorMsg}`);
        console.error(
          `[aiAction] Frame info:`,
          { src: iframeInfo.src, name: iframeInfo.name, xpath: iframeInfo.xpath }
        );
        console.error(
          `[aiAction] Available frames:`,
          page.frames().map((f) => ({ url: f.url(), name: f.name() }))
        );
      }
      throw new HyperagentError(errorMsg, 404);
    }

    if (this.debug) {
      console.log(
        `[aiAction] Using Playwright Frame ${frameIndex}: ${targetFrame.url()}`
      );
    }

    // Wait for iframe content to be loaded
    try {
      await targetFrame.waitForLoadState("domcontentloaded", { timeout: 5000 });
    } catch {
      if (this.debug) {
        console.warn(
          `[aiAction] Timeout waiting for iframe to load (frame ${frameIndex}), proceeding anyway`
        );
      }
      // Continue anyway - frame might already be loaded
    }

    if (this.debug) {
      console.log(
        `[aiAction] Using frame ${frameIndex} locator for element ${elementId}`
      );
      console.log(
        `[aiAction] Frame URL: ${targetFrame.url()}, Name: ${targetFrame.name()}`
      );
    }

    return { locator: targetFrame.locator(`xpath=${xpath}`), xpath };
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
    elementMap: Map<string, unknown>,
    limit: number = 20
  ): Array<{ id: string; role: string; label: string }> {
    // Group elements by frame
    const frameElements = new Map<
      string,
      Array<{ id: string; role: string; label: string }>
    >();

    for (const [id, elem] of elementMap) {
      // Type guard: ensure elem is an object with expected properties
      if (!elem || typeof elem !== "object") continue;

      const node = elem as Record<string, unknown>;
      const role = typeof node.role === "string" ? node.role : undefined;

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
        const name = typeof node.name === "string" ? node.name : undefined;
        const description =
          typeof node.description === "string" ? node.description : undefined;
        const value = typeof node.value === "string" ? node.value : undefined;
        const label = name || description || value || "";

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
    page: Page
  ): Promise<TaskOutput> {
    const startTime = new Date().toISOString();

    if (this.debug) {
      console.log(`[aiAction] Instruction: ${instruction}`);
    }

    let domState: A11yDOMState | null = null;
    let elementMap: Map<string, unknown> | null = null;

    try {
      // Find element with retry logic
      const {
        element,
        domState: foundDomState,
        elementMap: foundElementMap,
        llmResponse,
      } = await this.findElementWithRetry(
        instruction,
        page,
        HyperAgent.AIACTION_CONFIG.MAX_RETRIES,
        HyperAgent.AIACTION_CONFIG.RETRY_DELAY_MS,
        startTime
      );

      domState = foundDomState;
      elementMap = foundElementMap;

      if (this.debug) {
        console.log(`[aiAction] Found element: ${element.elementId}`);
        console.log(`[aiAction] Method: ${element.method}`);
        console.log(`[aiAction] Arguments:`, element.arguments);
      }

      // Get Playwright locator for the element (xpath is already trimmed by getElementLocator)
      const { locator, xpath } = await this.getElementLocator(
        element.elementId,
        domState.xpathMap,
        page,
        domState.frameMap
      );

      // Execute the Playwright method
      if (!element.method) {
        throw new HyperagentError(
          "Element method is missing from LLM response",
          500
        );
      }
      const method = element.method;
      const args = element.arguments || [];
      await this.executePlaywrightMethod(method, args, locator);

      // Wait for DOM to settle after action
      await waitForSettledDOM(page);

      // Write debug data on success
      await this.writeDebugData({
        instruction,
        page,
        startTime,
        domState,
        elementMap,
        element: {
          elementId: element.elementId,
          method,
          arguments: args,
          xpath,
        },
        llmResponse,
        success: true,
      });

      return {
        status: TaskStatus.COMPLETED,
        steps: [],
        output: `Successfully executed: ${instruction}`,
      };
    } catch (error) {
      // Write debug data on error
      await this.writeDebugData({
        instruction,
        page,
        startTime,
        domState,
        elementMap,
        error,
        success: false,
      });

      // Re-throw HyperagentErrors as-is
      if (error instanceof HyperagentError) {
        throw error;
      }
      // Wrap other errors
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new HyperagentError(`Failed to execute action: ${errorMsg}`, 500);
    }
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
    hyperPage.ai = (task: string, params?: TaskParams) =>
      this.executeTask(task, params, page);
    hyperPage.aiAction = (instruction: string) =>
      this.executeSingleAction(instruction, page);
    hyperPage.aiAsync = (task: string, params?: TaskParams) =>
      this.executeTaskAsync(task, params, page);
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
          page
        );
        if (outputSchema) {
          if (!res.output || res.output === "") {
            throw new Error(
              `Extract failed: Agent did not complete with output. Task status: ${res.status}. Check debug output for details.`
            );
          }
          return JSON.parse(res.output as string);
        }
        return res.output as string;
      } else {
        const res = await this.executeTask(
          "You have to perform a data extraction on the current page. Make sure your final response only contains the extracted content",
          taskParams,
          page
        );
        if (!res.output || res.output === "") {
          throw new Error(
            `Extract failed: Agent did not complete with output. Task status: ${res.status}. Check debug output for details.`
          );
        }
        return JSON.parse(res.output as string);
      }
    };
    return hyperPage;
  }
}
