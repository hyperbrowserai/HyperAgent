import HyperAgentDefault, {
  HyperAgent,
  HyperagentError,
  HyperagentTaskError,
  TaskStatus,
} from "@/index";
import type {
  ActionCacheOutput,
  ActionCacheReplayResult,
  ActionCacheReplayStepResult,
  AgentActionDefinition,
  AgentTaskOutput,
  HyperAgentConfig,
  HyperPage,
  HyperVariable,
  MCPConfig,
  MCPServerConfig,
  PerformOptions,
  PerformTaskParams,
  RunFromActionCacheParams,
  Task,
  TaskOutput,
  TaskParams,
} from "@/index";

describe("public API exports", () => {
  it("exposes runtime entrypoint symbols", () => {
    expect(HyperAgentDefault).toBe(HyperAgent);
    expect(TaskStatus.COMPLETED).toBe("completed");
    expect(new HyperagentError("boom")).toBeInstanceOf(Error);
    expect(
      new HyperagentTaskError("task-1", new Error("failed"))
    ).toBeInstanceOf(HyperagentError);
  });

  it("keeps core public types importable from the package entrypoint", () => {
    type PublicTypeSmoke = {
      actionCacheOutput: ActionCacheOutput;
      actionCacheReplayResult: ActionCacheReplayResult;
      actionCacheReplayStepResult: ActionCacheReplayStepResult;
      actionDefinition: AgentActionDefinition;
      agentTaskOutput: AgentTaskOutput;
      config: HyperAgentConfig;
      hyperPage: HyperPage;
      hyperVariable: HyperVariable;
      mcpConfig: MCPConfig;
      mcpServerConfig: MCPServerConfig;
      performOptions: PerformOptions;
      performTaskParams: PerformTaskParams;
      replayParams: RunFromActionCacheParams;
      task: Task;
      taskOutput: TaskOutput;
      taskParams: TaskParams;
    };

    const typeSmoke: PublicTypeSmoke | null = null;
    expect(typeSmoke).toBeNull();
  });

  it("keeps perform retry option fields available on public PerformTaskParams", () => {
    const performParams: PerformTaskParams = {
      maxElementRetries: 5,
      retryDelayMs: 250,
      maxContextSwitchRetries: 4,
      contextSwitchRetryDelayMs: 500,
      filterAdTrackingFrames: false,
    };

    expect(performParams.contextSwitchRetryDelayMs).toBe(500);
    expect(performParams.filterAdTrackingFrames).toBe(false);
  });

  it("exposes frame-filter configuration on public HyperAgentConfig", () => {
    const config: HyperAgentConfig = {
      filterAdTrackingFrames: false,
    };

    expect(config.filterAdTrackingFrames).toBe(false);
  });

  it("exposes frame-filter overrides on task and replay params", () => {
    const taskParams: TaskParams = {
      filterAdTrackingFrames: false,
    };
    const replayParams: RunFromActionCacheParams = {
      filterAdTrackingFrames: false,
    };

    expect(taskParams.filterAdTrackingFrames).toBe(false);
    expect(replayParams.filterAdTrackingFrames).toBe(false);
  });
});
