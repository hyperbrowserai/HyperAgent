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
  ActionContext,
  ActionType,
  AgentActionDefinition,
  ActionCacheOutput,
  ActionCacheReplayResult,
  RunFromActionCacheParams,
  endTaskStatuses,
  Task,
  TaskOutput,
  TaskParams,
  TaskState,
  TaskStatus,
} from "@/types";
import fs from "fs";
import {
  CompleteActionDefinition,
  DEFAULT_ACTIONS,
  generateCompleteActionWithOutputDefinition,
} from "./actions";
import {
  HyperbrowserProvider,
  LocalBrowserProvider,
} from "../browser-providers";
import { HyperagentError, HyperagentTaskError } from "./error";
import { findElementWithInstruction } from "./shared/find-element";
import {
  A11yDOMState,
  AccessibilityNode,
  isEncodedId,
} from "../context-providers/a11y-dom/types";
import { MCPClient } from "./mcp/client";
import { runAgentTask } from "./tools/agent";
import type {
  HyperPage,
  HyperVariable,
  ActionCacheEntry,
  AgentTaskOutput,
  PerformOptions,
  PerformTaskParams,
} from "../types/agent/types";
import { z } from "zod";
import { ErrorEmitter } from "../utils";
import { waitForSettledDOM } from "@/utils/waitForSettledDOM";
import { performance } from "perf_hooks";
import { ExamineDomResult } from "./examine-dom/types";
import { disposeAllCDPClients, resolveElement, dispatchCDPAction } from "@/cdp";
import { markDomSnapshotDirty } from "@/context-providers/a11y-dom/dom-cache";
import { setDebugOptions } from "@/debug/options";
import { initializeRuntimeContext } from "./shared/runtime-context";
import { performAction } from "./actions/shared/perform-action";
import { createScriptFromActionCache } from "./shared/action-cache-script";
import {
  attachCachedActionHelpers,
  dispatchPerformHelper,
  isPageActionMethod,
} from "./shared/action-cache-exec";
import { AgentDeps } from "@/types/agent/types";
import { parseExtractOutput } from "./shared/parse-extract-output";
import {
  executeReplaySpecialAction,
  REPLAY_SPECIAL_ACTION_TYPES,
} from "./shared/replay-special-actions";

const formatUnknownError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
};

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
  private actionCacheByTaskId: Record<string, ActionCacheOutput> = {};
  private taskResults: Record<string, Promise<AgentTaskOutput>> = {};
  private mcpActionTypesByServer: Map<string, Set<string>> = new Map();

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
    this.debug = params.debug ?? false;

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
    outputSchema?: z.ZodType<unknown>
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

  public getActionCache(taskId: string): ActionCacheOutput | null {
    const cache = this.actionCacheByTaskId[taskId];
    if (!cache) return null;
    return {
      ...cache,
      steps: [...cache.steps],
    };
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
      this.unregisterActionsByType(
        Array.from(this.mcpActionTypesByServer.values()).flatMap(
          (actionTypes) => Array.from(actionTypes)
        )
      );
      this.mcpActionTypesByServer.clear();
      try {
        await this.mcpClient.disconnect();
      } catch (error) {
        console.warn("[HyperAgent] Failed to disconnect MCP client:", error);
      } finally {
        this.mcpClient = undefined;
      }
    } else {
      this.unregisterActionsByType(
        Array.from(this.mcpActionTypesByServer.values()).flatMap(
          (actionTypes) => Array.from(actionTypes)
        )
      );
      this.mcpActionTypesByServer.clear();
    }

    if (this.browser) {
      try {
        await this.browserProvider.close();
      } catch (error) {
        console.warn("[HyperAgent] Failed to close browser provider:", error);
      } finally {
        this.browser = null;
        this.context = null;
      }
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

    // Poll context for new pages to catch any that opened since the last check
    // This handles race conditions where the 'page' event might not have fired yet
    // or where we missed it during a heavy operation.
    const pages = this.context.pages();
    if (pages.length > 0) {
      const lastPage = pages[pages.length - 1];
      // If the last page is different and not closed, switch to it
      // We prefer the newest page as it's likely the result of the user's last action
      if (lastPage && !lastPage.isClosed() && lastPage !== this._currentPage) {
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
  private getTaskControl(
    taskId: string,
    result: Promise<AgentTaskOutput>
  ): Task {
    const taskState = this.tasks[taskId];
    if (!taskState) {
      throw new HyperagentError(`Task ${taskId} not found`);
    }
    return {
      id: taskId,
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
      result,
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
    const taskResult = runAgentTask(
      {
        llm: this.llm,
        actions: this.getActions(mergedParams.outputSchema),
        tokenLimit: this.tokenLimit,
        debug: this.debug,
        mcpClient: this.mcpClient,
        variables: this._variables,
        cdpActions: this.cdpActionsEnabled,
        activePage: async () => activeTaskPage,
      },
      taskState,
      mergedParams
    )
      .then((result) => {
        this.actionCacheByTaskId[taskId] = result.actionCache;
        cleanup();
        return result;
      })
      .catch((error: unknown) => {
        cleanup();
        // Retrieve the correct state to update
        const failedTaskState = this.tasks[taskId];
        const taskFailureError =
          error instanceof Error
            ? new HyperagentTaskError(taskId, error)
            : new HyperagentTaskError(taskId, new Error(String(error)));
        if (failedTaskState) {
          failedTaskState.status = TaskStatus.FAILED;
          failedTaskState.error = taskFailureError.cause.message;
          // Emit error on the central emitter, including the taskId
          this.errorEmitter.emit("error", taskFailureError);
        } else {
          // Fallback if task state somehow doesn't exist
          console.error(
            `Task state ${taskId} not found during error handling.`
          );
        }
        throw taskFailureError;
      })
      .finally(() => {
        delete this.taskResults[taskId];
        delete this.tasks[taskId];
      });
    this.taskResults[taskId] = taskResult;
    return this.getTaskControl(taskId, taskResult);
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
  ): Promise<AgentTaskOutput> {
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
    try {
      const mergedParams = params ?? {};
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
        },
        taskState,
        mergedParams
      );
      this.context?.off("page", onPage);
      this.actionCacheByTaskId[taskId] = result.actionCache;
      delete this.tasks[taskId];
      return result;
    } catch (error) {
      this.context?.off("page", onPage);
      taskState.status = TaskStatus.FAILED;
      delete this.tasks[taskId];
      throw error;
    }
  }

  public async runFromActionCache(
    cache: ActionCacheOutput,
    pageOrGetter: Page | (() => Page),
    params?: RunFromActionCacheParams
  ): Promise<ActionCacheReplayResult> {
    const replayId = uuidv4();
    const maxXPathRetries = params?.maxXPathRetries ?? 3;
    const debug = params?.debug ?? this.debug;
    const getPage = () =>
      typeof pageOrGetter === "function" ? pageOrGetter() : pageOrGetter;

    const stepsResult: ActionCacheReplayResult["steps"] = [];
    let replayStatus: TaskStatus.COMPLETED | TaskStatus.FAILED =
      TaskStatus.COMPLETED;
    const recordReplayStep = (
      step: ActionCacheOutput["steps"][number],
      result: TaskOutput
    ): boolean => {
      const finalMeta = result.replayStepMeta;
      const finalSuccess = result.status === TaskStatus.COMPLETED;

      stepsResult.push({
        stepIndex: step.stepIndex,
        actionType: step.actionType,
        usedXPath: finalMeta?.usedCachedAction ?? false,
        fallbackUsed: finalMeta?.fallbackUsed ?? false,
        cachedXPath: finalMeta?.cachedXPath ?? null,
        fallbackXPath: finalMeta?.fallbackXPath ?? null,
        fallbackElementId: finalMeta?.fallbackElementId ?? null,
        retries: finalMeta?.retries ?? 0,
        success: finalSuccess,
        message:
          result.output ??
          (finalSuccess ? "Completed" : "Failed to execute cached action"),
      });

      if (!finalSuccess) {
        replayStatus = TaskStatus.FAILED;
      }
      return finalSuccess;
    };

    const getReplayInstruction = (
      instruction: string | undefined
    ): string | null => {
      const trimmed = instruction?.trim();
      return trimmed && trimmed.length > 0 ? trimmed : null;
    };

    for (const step of [...cache.steps].sort(
      (a, b) => a.stepIndex - b.stepIndex
    )) {
      const page = getPage();
      const hyperPage = page as HyperPage;
      let result: TaskOutput;
      let attemptedCachedAction = false;
      try {
        if (REPLAY_SPECIAL_ACTION_TYPES.has(step.actionType)) {
          attemptedCachedAction = true;
        }
        const replaySpecialResult = await executeReplaySpecialAction({
          taskId: cache.taskId,
          actionType: step.actionType,
          instruction: step.instruction,
          arguments: step.arguments,
          actionParams: step.actionParams,
          page: hyperPage,
          retries: 1,
        });

        if (replaySpecialResult) {
          attemptedCachedAction = true;
          result = replaySpecialResult;
        } else {
          const method = step.method?.trim();
          if (method && isPageActionMethod(method)) {
            const xpath = step.xpath?.trim();
            const hasXPath = typeof xpath === "string" && xpath.length > 0;
            const replayInstruction = getReplayInstruction(step.instruction);
            if (!hasXPath) {
              if (replayInstruction) {
                result = await hyperPage.perform(replayInstruction);
              } else {
                result = {
                  taskId: cache.taskId,
                  status: TaskStatus.FAILED,
                  steps: [],
                  output: `Cannot replay action type "${step.actionType}" with method "${method}" without XPath or instruction`,
                  replayStepMeta: {
                    usedCachedAction: false,
                    fallbackUsed: false,
                    retries: 0,
                    cachedXPath: null,
                    fallbackXPath: null,
                    fallbackElementId: null,
                  },
                };
              }
              if (!recordReplayStep(step, result)) {
                break;
              }
              continue;
            }
            const options: PerformOptions = {
              performInstruction: replayInstruction,
              maxSteps: maxXPathRetries,
            };
            if (step.frameIndex !== null && step.frameIndex !== undefined) {
              options.frameIndex = step.frameIndex;
            }
            const valueArg = step.arguments?.[0];
            attemptedCachedAction = true;
            result = await dispatchPerformHelper(
              hyperPage,
              method,
              xpath,
              valueArg,
              options
            );
          } else {
            const replayInstruction = getReplayInstruction(step.instruction);
            if (replayInstruction) {
              result = await hyperPage.perform(replayInstruction);
            } else {
              result = {
                taskId: cache.taskId,
                status: TaskStatus.FAILED,
                steps: [],
                output: `Cannot replay action type "${step.actionType}" without instruction`,
                replayStepMeta: {
                  usedCachedAction: false,
                  fallbackUsed: false,
                  retries: 0,
                  cachedXPath: null,
                  fallbackXPath: null,
                  fallbackElementId: null,
                },
              };
            }
          }
        }
      } catch (error: unknown) {
        const message = formatUnknownError(error);
        result = {
          taskId: cache.taskId,
          status: TaskStatus.FAILED,
          steps: [],
          output: `Replay step ${step.stepIndex} failed: ${message}`,
          replayStepMeta: {
            usedCachedAction: attemptedCachedAction,
            fallbackUsed: false,
            retries: 1,
            cachedXPath: step.xpath ?? null,
            fallbackXPath: null,
            fallbackElementId: null,
          },
        };
      }

      if (!recordReplayStep(step, result)) {
        break;
      }
    }

    const replayResult: ActionCacheReplayResult = {
      replayId,
      sourceTaskId: cache.taskId,
      steps: stepsResult,
      status: replayStatus,
    };

    if (debug) {
      try {
        const debugDir = "debug/action-cache";
        fs.mkdirSync(debugDir, { recursive: true });
        fs.writeFileSync(
          `${debugDir}/replay-${replayId}.json`,
          JSON.stringify(replayResult, null, 2)
        );
      } catch (error) {
        console.error("[runFromActionCache] Failed to write replay debug:", error);
      }
    }

    return replayResult;
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
    elementMap: Map<string, AccessibilityNode>;
    llmResponse: { rawText: string; parsed: unknown };
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
      }
    );

    // Check if element was found
    if (result.success && result.element) {
      // Success - return the result
      return {
        element: result.element,
        domState: result.domState,
        elementMap: result.elementMap,
        llmResponse: result.llmResponse!,
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
   * Internal method used by page.perform() (and deprecated page.aiAction())
   *
   * Architecture: Simple examine->act flow
   * - 1 LLM call (examineDom finds element and suggests method)
   * - Direct execution (no agent loop)
   *
   * @param instruction Natural language instruction for a single action
   * @param page The page to execute the action on
   * @returns A promise that resolves to the task output
   */
  public async executeSingleAction(
    instruction: string,
    pageOrGetter: Page | (() => Page),
    params?: PerformTaskParams
  ): Promise<TaskOutput> {
    const taskId = uuidv4();
    const actionStart = performance.now();
    const startTime = new Date().toISOString();
    if (this.debug) {
      console.log(`[aiAction] Instruction: ${instruction}`);
    }

    const getPage = () =>
      typeof pageOrGetter === "function" ? pageOrGetter() : pageOrGetter;
    const initialPage = getPage();

    let domState: A11yDOMState | null = null;
    let elementMap: Map<string, AccessibilityNode> | null = null;

    const maxRetries =
      params?.maxElementRetries ??
      params?.maxSteps ??
      HyperAgent.AIACTION_CONFIG.MAX_RETRIES;
    const retryDelayMs =
      params?.retryDelayMs ?? HyperAgent.AIACTION_CONFIG.RETRY_DELAY_MS;

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
        maxRetries,
        retryDelayMs,
        startTime
      );

      // Check if page context switched during findElement (e.g. new tab opened by previous action)
      if (getPage() !== initialPage) {
        throw new HyperagentError(
          "Page context switched during execution",
          409
        );
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
      const actionXPath: string | null =
        domState?.xpathMap?.[element.elementId] ?? null;

      // Use shared runtime context
      const { cdpClient, frameContextManager } = await initializeRuntimeContext(
        initialPage,
        this.debug
      );

      // Check context switch again before action
      if (getPage() !== initialPage) {
        throw new HyperagentError(
          "Page context switched during execution",
          409
        );
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

      logPerf(this.debug, "[Perf][executeSingleAction] total", actionStart);
      return {
        taskId,
        status: TaskStatus.COMPLETED,
        steps: [],
        output: `Successfully executed: ${instruction}`,
        actionCache: {
          taskId,
          createdAt: startTime,
          status: TaskStatus.COMPLETED,
          steps: [],
        },
        replayStepMeta: {
          usedCachedAction: false,
          fallbackUsed: false,
          retries: 1,
          cachedXPath: null,
          fallbackXPath: actionXPath ?? null,
          fallbackElementId: element.elementId ?? null,
        },
      };
    } catch (error) {
      // If page switched during execution, prioritize that over the error
      // This catches cases where findElement failed because the old page closed/navigated
      if (getPage() !== initialPage) {
        throw new HyperagentError(
          "Page context switched during execution",
          409
        );
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

      // Re-throw HyperagentErrors as-is
      if (error instanceof HyperagentError) {
        throw error;
      }
      // Wrap other errors
      const errorMsg = formatUnknownError(error);
      throw new HyperagentError(`Failed to execute action: ${errorMsg}`, 500);
    }
  }

  /**
   * Register a new action with the agent
   * @param action The action to register
   */
  private registerAction(action: AgentActionDefinition): void {
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

  private unregisterActionsByType(actionTypes: Iterable<string>): void {
    const removeTypes = new Set(actionTypes);
    if (removeTypes.size === 0) {
      return;
    }
    this.actions = this.actions.filter((action) => !removeTypes.has(action.type));
  }

  private registerMCPActions(
    serverId: string,
    actions: AgentActionDefinition[]
  ): void {
    const registeredActionTypes = new Set<string>();
    try {
      for (const action of actions) {
        this.registerAction(action);
        registeredActionTypes.add(action.type);
      }
      this.mcpActionTypesByServer.set(serverId, registeredActionTypes);
    } catch (error) {
      this.unregisterActionsByType(registeredActionTypes);
      this.mcpActionTypesByServer.delete(serverId);
      throw error;
    }
  }

  private unregisterMCPActionsForServer(serverId: string): void {
    const actionTypes = this.mcpActionTypesByServer.get(serverId);
    if (!actionTypes) {
      return;
    }
    this.unregisterActionsByType(actionTypes);
    this.mcpActionTypesByServer.delete(serverId);
  }

  private async resetMCPClient(): Promise<void> {
    if (this.mcpClient) {
      await this.mcpClient.disconnect().catch((error) => {
        if (this.debug) {
          console.warn("Failed to reset existing MCP client:", error);
        }
      });
      this.mcpClient = undefined;
    }
    this.unregisterActionsByType(
      Array.from(this.mcpActionTypesByServer.values()).flatMap((actionTypes) =>
        Array.from(actionTypes)
      )
    );
    this.mcpActionTypesByServer.clear();
  }

  /**
   * Initialize the MCP client with the given configuration
   * @param config The MCP configuration
   */
  public async initializeMCPClient(config: MCPConfig): Promise<void> {
    if (!config || config.servers.length === 0) {
      return;
    }
    await this.resetMCPClient();
    this.mcpClient = new MCPClient(this.debug);
    try {
      for (const serverConfig of config.servers) {
        try {
          const { serverId, actions } =
            await this.mcpClient.connectToServer(serverConfig);
          try {
            this.registerMCPActions(serverId, actions);
          } catch (registrationError) {
            await this.mcpClient.disconnectServer(serverId).catch(() => {});
            throw registrationError;
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
      try {
        this.registerMCPActions(serverId, actions);
      } catch (registrationError) {
        await this.mcpClient.disconnectServer(serverId).catch(() => {});
        throw registrationError;
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

    const isConnected = this.mcpClient.getServerIds().includes(serverId);
    if (!isConnected) {
      this.unregisterMCPActionsForServer(serverId);
      return false;
    }

    try {
      this.unregisterMCPActionsForServer(serverId);
      void this.mcpClient.disconnectServer(serverId).catch((error) => {
        console.error(`Failed to disconnect from MCP server ${serverId}:`, error);
      });
      return true;
    } catch (error) {
      console.error(`Failed to disconnect from MCP server ${serverId}:`, error);
      return false;
    }
  }

  /**
   * Disconnect from a specific MCP server and await transport cleanup.
   * @param serverId ID of the server to disconnect from
   * @returns Boolean indicating if disconnection was successful
   */
  public async disconnectFromMCPServerAsync(serverId: string): Promise<boolean> {
    if (!this.mcpClient) {
      return false;
    }
    const isConnected = this.mcpClient.getServerIds().includes(serverId);
    if (!isConnected) {
      this.unregisterMCPActionsForServer(serverId);
      return false;
    }

    this.unregisterMCPActionsForServer(serverId);
    try {
      await this.mcpClient.disconnectServer(serverId);
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

  public createScriptFromActionCache(
    steps: ActionCacheEntry[],
    taskId?: string
  ): string {
    return createScriptFromActionCache({ steps, taskId });
  }

  private setupHyperPage(page: Page): HyperPage {
    const hyperPage = page as HyperPage;
    const scopedPage = hyperPage as HyperPage & {
      _scopeListenerCleanup?: () => void;
    };

    // Clean up existing listener if this page was already setup
    if (scopedPage._scopeListenerCleanup) {
      scopedPage._scopeListenerCleanup();
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
    scopedPage._scopeListenerCleanup = () => {
      page.context().off("page", onPage);
    };

    const executeSingleActionWithRetry = async (
      instruction: string,
      params?: PerformTaskParams
    ) => {
      const maxRetries = params?.maxContextSwitchRetries ?? 3;
      for (let i = 0; i < maxRetries; i++) {
        try {
          return await this.executeSingleAction(
            instruction,
            getActivePage,
            params
          );
        } catch (err: unknown) {
          const isPageSwitchError =
            err instanceof HyperagentError
              ? err.statusCode === 409
              : err instanceof Error
                ? err.message.includes("Page context switched")
                : false;
          if (
            isPageSwitchError
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

    hyperPage.ai = (task: string, params?: TaskParams) =>
      this.executeTask(task, params, getActivePage());

    hyperPage.perform = (instruction: string, params?: PerformTaskParams) =>
      executeSingleActionWithRetry(instruction, params);

    hyperPage.aiAction = (instruction: string, params?: PerformTaskParams) =>
      executeSingleActionWithRetry(instruction, params);

    hyperPage.getActionCache = (taskId: string) => this.getActionCache(taskId);

    hyperPage.runFromActionCache = (cache, params) =>
      this.runFromActionCache(cache, getActivePage, params);

    const deps: AgentDeps = {
      debug: this.debug,
      tokenLimit: this.tokenLimit,
      llm: this.llm,
      mcpClient: this.mcpClient,
      variables: Object.values(this._variables),
      cdpActionsEnabled: this.cdpActionsEnabled,
    };
    attachCachedActionHelpers(deps, hyperPage);

    // aiAsync tasks run in background, so we just use the current scope start point.
    // The task itself has internal auto-following logic (from executeTaskAsync implementation).
    hyperPage.aiAsync = (task: string, params?: TaskParams) =>
      this.executeTaskAsync(task, params, getActivePage());

    hyperPage.extract = async <
      T extends z.ZodType<unknown> | undefined = undefined,
    >(
      task?: string,
      outputSchema?: T,
      params?: Omit<TaskParams, "outputSchema">
    ): Promise<T extends z.ZodType<unknown> ? z.infer<T> : string> => {
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
        if (!outputSchema) {
          return parseExtractOutput(res.output, res.status) as T extends z.ZodType<unknown>
            ? z.infer<T>
            : string;
        }
        return parseExtractOutput(
          res.output,
          res.status,
          outputSchema as z.ZodType<unknown>
        ) as T extends z.ZodType<unknown> ? z.infer<T> : string;
      } else {
        const res = await this.executeTask(
          "You have to perform a data extraction on the current page. Make sure your final response only contains the extracted content",
          taskParams,
          getActivePage()
        );
        if (!outputSchema) {
          throw new HyperagentError(
            "No output schema provided for schema-only extraction",
            400
          );
        }
        return parseExtractOutput(
          res.output,
          res.status,
          outputSchema
        ) as T extends z.ZodType<unknown> ? z.infer<T> : string;
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
