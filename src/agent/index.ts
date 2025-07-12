import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import { Browser, BrowserContext, Locator, Page } from "playwright";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

import { getDom } from "@/context-providers/dom";
import {
  BrowserProviders,
  HyperAgentConfig,
  MCPConfig,
  MCPServerConfig,
} from "@/types/config";
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
import { SYSTEM_PROMPT_FIND_ELEMENT } from "./messages/system-prompt";
import { MCPClient } from "./mcp/client";
import { compositeScreenshot, runAgentTask } from "./tools/agent";
import { HyperPage, HyperVariable } from "@/types/agent/types";
import { buildAgentStepMessages } from "./messages/builder";
import { ErrorEmitter } from "@/utils";
import { retry } from "@/utils/retry";
import { sleep } from "@/utils/sleep";
import { getLocator } from "./actions/utils";

const ResponseSchema = z.object({
  index: z.number().describe("The index number of the element"),
});

export class HyperAgent<T extends BrowserProviders = "Local"> {
  public llm: BaseChatModel;
  private tasks: Record<string, TaskState> = {};
  private tokenLimit = 128000; // Default token limit
  private debug = false;
  private mcpClient: MCPClient | undefined;
  private browserProvider: T extends "Hyperbrowser"
    ? HyperbrowserProvider
    : LocalBrowserProvider;
  private browserProviderType: T;
  private actions: Array<AgentActionDefinition> = [...DEFAULT_ACTIONS];
  private generateScript = false;
  private scriptPath?: string;
  private config: HyperAgentConfig<T>;

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
    this.config = params;
    if (!params.llm) {
      if (process.env.OPENAI_API_KEY) {
        this.llm = new ChatOpenAI({
          openAIApiKey: process.env.OPENAI_API_KEY,
          modelName: "gpt-4o",
          temperature: 0,
        });
      } else {
        throw new HyperagentError("No LLM provider provided", 400);
      }
    } else {
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
    this.generateScript = params.generateScript ?? false;
    this.scriptPath = params.scriptPath;
    this.tokenLimit = params.tokenLimit ?? this.tokenLimit;
    this.errorEmitter = new ErrorEmitter();
  }

  /**
   *  This is just exposed as a utility function. You don't need to call it explicitly.
   * @returns A reference to the current Playwright browser instance.
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
          options?: boolean | AddEventListenerOptions,
        ) {
          if (interactiveEvents.has(type.toLowerCase())) {
            this.setAttribute("data-has-interactive-listener", "true");
          }
          originalAddEventListener.call(this, type, listener, options);
        };
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
    outputSchema?: z.AnyZodObject,
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
    initPage?: Page,
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

    const debugDir = params?.debugDir || `debug/${taskId}`;
    const scriptFile = this.generateScript
      ? this.scriptPath
        ? this.scriptPath
        : `${debugDir}/script.ts`
      : undefined;
    runAgentTask(
      {
        llm: this.llm,
        actions: this.getActions(params?.outputSchema),
        tokenLimit: this.tokenLimit,
        debug: this.debug,
        generateScript: this.generateScript,
        scriptFile: scriptFile,
        debugDir: debugDir,
        mcpClient: this.mcpClient,
        variables: this._variables,
        agentConfig: this.config,
      },
      taskState,
      params,
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
    initPage?: Page,
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

    const debugDir = params?.debugDir || `debug/${taskId}`;
    const scriptFile = this.generateScript
      ? this.scriptPath
        ? this.scriptPath
        : `${debugDir}/script.ts`
      : undefined;
    try {
      return await runAgentTask(
        {
          llm: this.llm,
          actions: this.getActions(params?.outputSchema),
          tokenLimit: this.tokenLimit,
          debug: this.debug,
          generateScript: this.generateScript,
          scriptFile: scriptFile,
          debugDir: debugDir,
          mcpClient: this.mcpClient,
          variables: this._variables,
          agentConfig: this.config,
        },
        taskState,
        params,
      );
    } catch (error) {
      taskState.status = TaskStatus.FAILED;
      throw error;
    }
  }

  public async getLocator(
    querySelector: string,
    fallbackDescription: string,
    page: Page,
  ): Promise<Locator> {
    const locator = page.locator(querySelector);

    let count = await locator.count();
    if (count > 0) {
      return locator;
    }

    const fallbackLocator = await this.findElement(fallbackDescription, page);
    if (fallbackLocator) {
      count = await fallbackLocator.count();
      if (count > 0) {
        return fallbackLocator;
      }
    }

    throw new HyperagentError(
      `Element not found for description: ${fallbackDescription}`,
    );
  }

  private async findElement(
    taskDescription: string,
    page: Page,
  ): Promise<Locator | null> {
    // Get the DOM state
    let domState;
    while (!domState) {
      domState = await retry({ func: () => getDom(page) });
      if (!domState) {
        console.log("No DOM state, waiting 1 second.");
        await sleep(1000);
      }
    }

    // Get the screenshot ready with indexes
    const trimmedScreenshot = await compositeScreenshot(
      page,
      domState.screenshot.startsWith("data:image/png;base64,")
        ? domState.screenshot.slice("data:image/png;base64,".length)
        : domState.screenshot,
    );

    // Build Agent Step Messages
    const baseMsgs = [{ role: "system", content: SYSTEM_PROMPT_FIND_ELEMENT }];
    const msgs = await buildAgentStepMessages(
      baseMsgs,
      [],
      taskDescription,
      page,
      domState,
      trimmedScreenshot as string,
      [],
    );

    // Invoke LLM
    const llmStructured = this.llm.withStructuredOutput(ResponseSchema);
    const agentOutput = await retry({
      func: () => llmStructured.invoke(msgs),
    });

    // Check if agentOutput is null/undefined or doesn't have the expected structure
    if (!agentOutput || typeof agentOutput.index !== "number") {
      console.warn(
        "LLM failed to return valid structured output for element finding",
      );
    }

    // Check if agentOutput is null/undefined or doesn't have the expected structure
    if (!agentOutput || typeof agentOutput.index !== "number") {
      console.warn(
        "LLM failed to return valid structured output for element finding",
      );
      return null;
    }

    // Return the element locator
    const actionCtx: ActionContext = {
      domState,
      page,
      tokenLimit: this.tokenLimit,
      llm: this.llm,
      debugDir: undefined,
      mcpClient: undefined,
      variables: {},
    };
    const locator = getLocator(actionCtx, agentOutput.index);
    if (!locator) {
      return null;
    }
    return locator;
  }

  /**
   * Register a new action with the agent
   * @param action The action to register
   */
  private async registerAction(action: AgentActionDefinition) {
    if (action.type === "complete") {
      throw new HyperagentError(
        "Could not add an action with the name 'complete'. Complete is a reserved action.",
        400,
      );
    }
    const actionsList = new Set(
      this.actions.map((registeredAction) => registeredAction.type),
    );
    if (actionsList.has(action.type)) {
      throw new Error(
        `Could not register action of type ${action.type}. Action with the same name is already registered`,
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
            error,
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
    serverConfig: MCPServerConfig,
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
      (actions) => actions.type === action.type,
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
    hyperPage.aiAsync = (task: string, params?: TaskParams) =>
      this.executeTaskAsync(task, params, page);
    hyperPage.extract = async (task, outputSchema) => {
      if (!task && !outputSchema) {
        throw new HyperagentError(
          "No task description or output schema specified",
          400,
        );
      }
      if (task) {
        const res = await this.executeTask(
          `You have to perform an extraction on the current page. You have to perform the extraction according to the task: ${task}. Make sure your final response only contains the extracted content`,
          {
            maxSteps: 2,
            outputSchema,
          },
          page,
        );
        if (outputSchema) {
          return JSON.parse(res.output as string);
        }
        return res.output as string;
      } else {
        const res = await this.executeTask(
          "You have to perform a data extraction on the current page. Make sure your final response only contains the extracted content",
          { maxSteps: 2, outputSchema },
          page,
        );
        return JSON.parse(res.output as string);
      }
    };
    hyperPage.getLocator = (
      querySelector: string,
      fallbackDescription: string,
    ) => this.getLocator(querySelector, fallbackDescription, page);
    return hyperPage;
  }
}
