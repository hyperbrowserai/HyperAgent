import { Browser, BrowserContext, Page } from "patchright";
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
import { MCPClient } from "./mcp/client";
import { runAgentTask } from "./tools/agent";
import { HyperPage, HyperVariable } from "@/types/agent/types";
import { z } from "zod";
import { ErrorEmitter } from "@/utils";

export class HyperAgent<T extends BrowserProviders = "Local"> {
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

        // Immediately switch to the new page (like Stagehand does)
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
   * Execute a single granular action using a11y mode
   * Internal method used by page.aiAction()
   *
   * Architecture: Matches Stagehand's simple observe→act flow
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
    const { examineDom } = await import("./examine-dom");
    const { getUnifiedDOM } = await import("../context-providers/unified-dom");
    const { waitForSettledDOM } = await import("../utils/waitForSettledDOM");
    const { writeAiActionDebug } = await import("../utils/debugWriter");

    const startTime = new Date().toISOString();

    if (this.debug) {
      console.log(`[aiAction] Instruction: ${instruction}`);
    }

    let domState: Awaited<ReturnType<typeof getUnifiedDOM>> = null;
    let stringElements: Map<string, Record<string, unknown>> | null = null;
    let elements: Awaited<ReturnType<typeof examineDom>> | null = null;

    // Retry configuration
    const MAX_RETRIES = 10;
    const RETRY_DELAY_MS = 1000;

    try {
      // Retry loop for element finding
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        // Step 1: Wait for DOM to settle
        // This ensures dynamic content like dropdowns have finished loading
        if (this.debug) {
          if (attempt === 0) {
            console.log(`[aiAction] Waiting for DOM to settle...`);
          } else {
            console.log(`[aiAction] Retry ${attempt + 1}/${MAX_RETRIES}: Waiting for DOM to settle...`);
          }
        }
        await waitForSettledDOM(page);
        if (this.debug) {
          console.log(`[aiAction] DOM settled`);
        }

        // Step 2: Fetch a11y tree
        domState = await getUnifiedDOM(page, { mode: "a11y" });

        if (!domState) {
          return {
            status: TaskStatus.FAILED,
            steps: [],
            output: "Failed to fetch page structure",
          };
        }

        if (this.debug) {
          console.log(
            `[aiAction] Fetched a11y tree: ${domState.elements.size} elements`
          );
        }

        // Step 3: Call examineDom to find element and determine method
        // (Like Stagehand's observe with returnAction: true)

        // Convert elements map to string-only keys (a11y mode uses string keys)
        stringElements = new Map<string, Record<string, unknown>>();
        for (const [key, value] of domState.elements) {
          stringElements.set(String(key), value as Record<string, unknown>);
        }

        if (this.debug) {
          console.log(`[aiAction] Calling examineDom to find element for: "${instruction}"`);
        }

        elements = await examineDom(
          instruction,
          {
            tree: domState.domState,
            xpathMap: domState.xpathMap || {},
            elements: stringElements,
            url: page.url(),
          },
          this.llm
        );

        // Check if element was found
        if (elements && elements.length > 0) {
          // Found it! Break out of retry loop
          if (this.debug && attempt > 0) {
            console.log(`[aiAction] Element found on attempt ${attempt + 1}`);
          }
          break;
        }

        // Element not found - retry or fail
        if (attempt < MAX_RETRIES - 1) {
          if (this.debug) {
            console.log(`[aiAction] Element not found, retrying in ${RETRY_DELAY_MS}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
          }
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }

      // After all retries, check if element was found
      if (!elements || elements.length === 0) {
        if (this.debug && domState && stringElements) {
          console.error(`[aiAction] No elements found for instruction: "${instruction}" after ${MAX_RETRIES} attempts`);
          console.error(`[aiAction] Current URL: ${page.url()}`);
          console.error(`[aiAction] Total elements in final a11y tree: ${domState.elements.size}`);

          // Show a sample of available interactive elements
          const interactiveElements: string[] = [];
          for (const [id, elem] of stringElements) {
            const role = elem.role as string | undefined;
            if (role && ['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'tab', 'menuitem'].includes(role)) {
              const name = elem.name as string | undefined;
              const description = elem.description as string | undefined;
              const value = elem.value as string | undefined;
              const label = name || description || value || '';
              if (label) {
                interactiveElements.push(`  - ${role}: "${label.slice(0, 60)}${label.length > 60 ? '...' : ''}" [${id}]`);
              }
            }
            if (interactiveElements.length >= 20) break; // Limit to first 20
          }

          if (interactiveElements.length > 0) {
            console.error(`[aiAction] Available interactive elements (first ${interactiveElements.length}):`);
            console.error(interactiveElements.join('\n'));
            console.error(`[aiAction] Try using one of the exact labels above in your instruction`);
          } else {
            console.error(`[aiAction] No interactive elements found in a11y tree`);
            console.error(`[aiAction] The page may not have fully loaded, or the element might be in an iframe`);
          }
        }

        const errorMsg =
          `No elements found for instruction: "${instruction}" after ${MAX_RETRIES} retry attempts. The instruction may be too vague, the element may not exist, or the page may not have fully loaded.`;
        throw new HyperagentError(errorMsg, 404);
      }

      const element = elements[0];

      if (this.debug) {
        console.log(`[aiAction] Found element: ${element.elementId}`);
        console.log(`[aiAction] Method: ${element.method}`);
        console.log(`[aiAction] Arguments:`, element.arguments);
      }

      // Step 4: Execute the Playwright action directly
      const xpathMap = domState?.xpathMap || {};

      if (this.debug) {
        console.log(`[aiAction] xpathMap sample:`, JSON.stringify(
          Object.fromEntries(Object.entries(xpathMap).slice(0, 3)),
          null,
          2
        ));
      }

      // Cast elementId to the correct type for lookup
      const rawXpath = xpathMap[element.elementId as `${number}-${number}`];
      if (!rawXpath) {
        const errorMsg = `Element ${element.elementId} not found in xpath map`;
        if (this.debug) {
          console.error(`[aiAction] ${errorMsg}`);
          console.error(`[aiAction] Available element IDs in xpathMap:`, Object.keys(xpathMap).slice(0, 20));
          console.error(`[aiAction] Looking for element with ID: ${element.elementId} (type: ${typeof element.elementId})`);
          console.error(`[aiAction] Direct lookup result:`, xpathMap[element.elementId as `${number}-${number}`]);
        }
        throw new HyperagentError(errorMsg, 404);
      }

      // Trim trailing text nodes (exactly like Stagehand's trimTrailingTextNode)
      const xpath = rawXpath.replace(/\/text\(\)(\[\d+\])?$/iu, "");

      const locator = page.locator(`xpath=${xpath}`);

      // Execute the method (default to 'click' if not specified)
      const method = element.method || "click";
      const args = element.arguments || [];

      switch (method) {
        case "click":
          // Match Stagehand exactly: no explicit scroll, rely on Playwright's auto-scroll
          try {
            await locator.click({ timeout: 3500 });
          } catch (error) {
            // Fallback to JS click
            if (this.debug) {
              console.log(
                `[aiAction] Playwright click failed, trying JS click`
              );
            }
            try {
              await locator.evaluate(
                (el: HTMLElement) => el.click(),
                undefined,
                { timeout: 3500 }
              );
            } catch {
              throw error; // Throw original error if JS click also fails
            }
          }
          break;
        case "type":
        case "fill":
          await locator.fill(args[0] || "");
          break;
        case "selectOption":
        case "selectOptionFromDropdown":
          await locator.selectOption(args[0] || "");
          break;
        case "hover":
          await locator.hover();
          break;
        case "press":
          await locator.press(args[0] || "Enter");
          break;
        case "check":
          await locator.check();
          break;
        case "uncheck":
          await locator.uncheck();
          break;
        case "scroll":
        case "scrollTo":
          {
            // Scroll to percentage - matches Stagehand's scrollElementToPercentage
            const scrollArg = (args[0] || "50%").toString();
            await locator.evaluate((element, { yArg }) => {
              function parsePercent(val: string): number {
                const cleaned = val.trim().replace("%", "");
                const num = parseFloat(cleaned);
                return Number.isNaN(num) ? 0 : Math.max(0, Math.min(num, 100));
              }

              const yPct = parsePercent(yArg);

              if (element.tagName.toLowerCase() === "html") {
                const scrollHeight = document.body.scrollHeight;
                const viewportHeight = window.innerHeight;
                const scrollTop = (scrollHeight - viewportHeight) * (yPct / 100);
                window.scrollTo({
                  top: scrollTop,
                  left: window.scrollX,
                  behavior: "smooth",
                });
              } else {
                const scrollHeight = element.scrollHeight;
                const clientHeight = element.clientHeight;
                const scrollTop = (scrollHeight - clientHeight) * (yPct / 100);
                element.scrollTo({
                  top: scrollTop,
                  left: element.scrollLeft,
                  behavior: "smooth",
                });
              }
            }, { yArg: scrollArg });
          }
          break;
        case "nextChunk":
          // Matches Stagehand's scrollToNextChunk
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
              const scrollingRoot = (document.scrollingElement ?? document.documentElement) as HTMLElement;
              return waitForScrollEnd(scrollingRoot);
            }

            const height = (element as HTMLElement).getBoundingClientRect().height;
            (element as HTMLElement).scrollBy({
              top: height,
              left: 0,
              behavior: "smooth",
            });
            return waitForScrollEnd(element);
          });
          break;
        case "prevChunk":
          // Matches Stagehand's scrollToPreviousChunk
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
              const rootScrollingEl = (document.scrollingElement ?? document.documentElement) as HTMLElement;
              return waitForScrollEnd(rootScrollingEl);
            }

            const height = (element as HTMLElement).getBoundingClientRect().height;
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

      // Step 5: Wait for DOM to settle after action (like Stagehand does after each action)
      await waitForSettledDOM(page);

      // Write debug data on success
      if (this.debug && domState && stringElements) {
        try {
          const screenshot = await page.screenshot({ type: "png" });
          await writeAiActionDebug({
            instruction,
            url: page.url(),
            timestamp: startTime,
            domElementCount: domState.elements.size,
            domTree: domState.domState,
            screenshot,
            foundElement: {
              elementId: element.elementId as string,
              method: element.method || "click",
              arguments: element.arguments || [],
              xpath,
            },
            success: true,
          });
        } catch (debugError) {
          console.error(`[aiAction] Failed to write debug data:`, debugError);
        }
      }

      return {
        status: TaskStatus.COMPLETED,
        steps: [],
        output: `Successfully executed: ${instruction}`,
      };
    } catch (error) {
      if (this.debug) {
        console.error(`[aiAction] Error:`, error);

        // Write debug data on error
        if (domState && stringElements) {
          try {
            const screenshot = await page.screenshot({ type: "png" }).catch(() => null);

            // Collect available elements for debugging
            const availableElements: Array<{ id: string; role: string; label: string }> = [];
            for (const [id, elem] of stringElements) {
              const role = elem.role as string | undefined;
              if (role && ['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'tab', 'menuitem'].includes(role)) {
                const name = elem.name as string | undefined;
                const description = elem.description as string | undefined;
                const value = elem.value as string | undefined;
                const label = name || description || value || '';
                if (label) {
                  availableElements.push({ id, role, label });
                }
              }
              if (availableElements.length >= 50) break; // Store more in file than console
            }

            await writeAiActionDebug({
              instruction,
              url: page.url(),
              timestamp: startTime,
              domElementCount: domState.elements.size,
              domTree: domState.domState,
              screenshot: screenshot || undefined,
              availableElements,
              error: {
                message: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
              },
              success: false,
            });
          } catch (debugError) {
            console.error(`[aiAction] Failed to write debug data:`, debugError);
          }
        }
      }

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
          console.log(`MCP server ${serverId} initialized successfully`);
        } catch (error) {
          console.error(
            `Failed to initialize MCP server ${serverConfig.id || "unknown"}:`,
            error
          );
        }
      }

      const serverIds = this.mcpClient.getServerIds();
      console.log(`Successfully connected to ${serverIds.length} MCP servers`);
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

      console.log(`Connected to MCP server with ID: ${serverId}`);
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
          return JSON.parse(res.output as string);
        }
        return res.output as string;
      } else {
        const res = await this.executeTask(
          "You have to perform a data extraction on the current page. Make sure your final response only contains the extracted content",
          taskParams,
          page
        );
        return JSON.parse(res.output as string);
      }
    };
    return hyperPage;
  }
}
