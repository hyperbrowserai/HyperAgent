import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { HyperAgent } from "@/agent";
import { TaskStatus } from "@/types";
import { scopeDomWithSelector } from "@/context-providers/dom/selector-scope";
import { captureDOMState } from "@/agent/shared/dom-capture";
import { computeStructuralDomHash } from "@/context-providers/dom/structural-hash";
import { runAgentTask } from "@/agent/tools/agent";
import { z } from "zod";

jest.mock("uuid", () => ({ v4: () => "test-uuid" }));
jest.mock("@/agent/shared/dom-capture");
jest.mock("@/context-providers/dom/structural-hash");
jest.mock("@/context-providers/dom/selector-scope");
jest.mock("@/agent/tools/agent");

// Reuse cache across tests by unique temp dir per test
const tmpBase = path.join(os.tmpdir(), "hyperagent-cache-tests");
beforeAll(async () => {
  await fs.mkdir(tmpBase, { recursive: true }).catch(() => {});
});
const mockCaptureDomState = captureDOMState as jest.MockedFunction<
  typeof captureDOMState
>;
const mockComputeStructuralDomHash =
  computeStructuralDomHash as jest.MockedFunction<
    typeof computeStructuralDomHash
  >;
const mockScopeDomWithSelector = scopeDomWithSelector as jest.MockedFunction<
  typeof scopeDomWithSelector
>;
const mockRunAgentTask = runAgentTask as jest.MockedFunction<
  typeof runAgentTask
>;

const fakeDomState = () => ({
  domState: "FULL DOM SNAPSHOT WITH MANY NODES",
  elements: new Map(),
  xpathMap: {},
  backendNodeMap: {},
});

const scopedDomState = () => ({
  domState: "SCOPED DOM",
  elements: new Map(),
  xpathMap: {},
  backendNodeMap: {},
});

const fakeLLM = {
  getModelId: () => "test-model",
} as any;

const createAgentWithCache = async () => {
  const tmpDir = await fs.mkdtemp(path.join(tmpBase, "cache-"));
  return new HyperAgent({
    llm: fakeLLM,
    cacheDir: tmpDir,
  });
};

describe("page.extract cache smoke test", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCaptureDomState.mockResolvedValue(fakeDomState() as any);
    mockScopeDomWithSelector.mockImplementation(async (_page, domState) => ({
      domState: { ...scopedDomState(), domState: scopedDomState().domState },
      matched: true,
    }));
    mockComputeStructuralDomHash.mockResolvedValue({
      structuralHash: "structural-hash-1",
      contentHash: "content-hash-1",
      fullHash: "full-hash-1",
    });
    mockRunAgentTask.mockResolvedValue({
      status: TaskStatus.COMPLETED,
      steps: [],
      output: JSON.stringify("extracted-text"),
    });
  });

  it("reuses cached extract results and scopes DOM for selectors", async () => {
    const agent = await createAgentWithCache();
    const contextStub = {
      on: jest.fn(),
      off: jest.fn(),
    };
    const pageStub = {
      url: () => "https://example.com",
      on: jest.fn(),
      off: jest.fn(),
      context: () => contextStub,
    } as any;

    agent.currentPage = pageStub;
    const page = agent.currentPage!;

    const schema = z.string();

    const first = await page.extract("Get text", schema, {
      selector: ".item",
    });

    // Wait for async cache write before second call
    await (agent as any).cacheManager.flushPending?.();

    const second = await page.extract("Get text", schema, {
      selector: ".item",
    });

    expect(first).toBe("extracted-text");
    expect(second).toBe("extracted-text");

    expect(mockRunAgentTask).toHaveBeenCalledTimes(1);

    const initialDom = (mockRunAgentTask.mock.calls[0]?.[0] as any)
      .initialDomState;
    expect(initialDom?.domState).toBe("SCOPED DOM");
    expect(fakeDomState().domState.length).toBeGreaterThan(
      initialDom.domState.length
    );

    const metrics = agent.metrics;
    expect(metrics.cache.hits).toBe(1);
    expect(metrics.cache.writes).toBe(1);
  });
});

describe("async task cache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCaptureDomState.mockResolvedValue(fakeDomState() as any);
    mockComputeStructuralDomHash.mockResolvedValue({
      structuralHash: "structural-hash-async",
      contentHash: "content-hash-async",
      fullHash: "full-hash-async",
    });
    mockRunAgentTask.mockResolvedValue({
      status: TaskStatus.COMPLETED,
      steps: [],
      output: JSON.stringify("async-result"),
    });
  });

  it("returns cached result for executeTaskAsync and fires onComplete", async () => {
    const agent = await createAgentWithCache();
    const pageStub = {
      url: () => "https://example.com/async",
    } as any;
    agent.currentPage = pageStub;

    const onComplete = jest.fn();

    // First run writes cache
    const schema = z.string();

    const control1 = await agent.executeTaskAsync(
      "Do async thing",
      { outputSchema: schema },
      pageStub
    );
    await waitFor(() => mockRunAgentTask.mock.calls.length >= 1);
    await (agent as any).cacheManager.flushPending?.();

    // Second run should hit cache and still call onComplete
    const control2 = await agent.executeTaskAsync(
      "Do async thing",
      { onComplete, outputSchema: schema },
      pageStub
    );

    // Allow microtasks
    await waitFor(() => mockRunAgentTask.mock.calls.length >= 2 || onComplete.mock.calls.length >= 1);
    await new Promise((r) => setTimeout(r, 0));

    expect(mockRunAgentTask).toHaveBeenCalledTimes(1); // cache hit should skip second run
    expect(onComplete).toHaveBeenCalledTimes(1);

    // Ensure control objects still usable
    expect(control1.getStatus()).not.toBe(TaskStatus.FAILED);
    expect(control2.getStatus()).not.toBe(TaskStatus.FAILED);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 100): Promise<void> {
  const start = Date.now();
  return new Promise<void>((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("waitFor timeout"));
      }
      setTimeout(check, 0);
    };
    check();
  });
}

describe("action cache strategies", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCaptureDomState.mockResolvedValue(fakeDomState() as any);
    mockComputeStructuralDomHash.mockResolvedValue({
      structuralHash: "structural-hash-action",
      contentHash: "content-hash-action",
      fullHash: "full-hash-action",
    });
    mockRunAgentTask.mockResolvedValue({
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "action-completed",
    });
  });

  it("'full' strategy skips execution on cache hit", async () => {
    const agent = await createAgentWithCache();
    const contextStub = {
      on: jest.fn(),
      off: jest.fn(),
    };
    const pageStub = {
      url: () => "https://example.com/action-full",
      on: jest.fn(),
      off: jest.fn(),
      context: () => contextStub,
    } as any;

    agent.currentPage = pageStub;

    // First execution writes to cache
    await agent.executeTask("Click button", { cacheStrategy: "full" }, pageStub);
    await (agent as any).cacheManager.flushPending?.();

    // Second execution should skip (cache hit with full strategy)
    await agent.executeTask("Click button", { cacheStrategy: "full" }, pageStub);

    // runAgentTask should only be called once (second call skipped)
    expect(mockRunAgentTask).toHaveBeenCalledTimes(1);

    const metrics = agent.metrics;
    expect(metrics.cache.hits).toBe(1);
    expect(metrics.cache.writes).toBe(1);
  });

  it("'result-only' strategy still executes on cache hit", async () => {
    const agent = await createAgentWithCache();
    const contextStub = {
      on: jest.fn(),
      off: jest.fn(),
    };
    const pageStub = {
      url: () => "https://example.com/action-result-only",
      on: jest.fn(),
      off: jest.fn(),
      context: () => contextStub,
    } as any;

    agent.currentPage = pageStub;

    // First execution writes to cache
    await agent.executeTask(
      "Click checkout",
      { cacheStrategy: "result-only" },
      pageStub
    );
    await (agent as any).cacheManager.flushPending?.();

    // Second execution should still run (result-only doesn't skip execution)
    await agent.executeTask(
      "Click checkout",
      { cacheStrategy: "result-only" },
      pageStub
    );

    // runAgentTask should be called twice (both executions run)
    expect(mockRunAgentTask).toHaveBeenCalledTimes(2);

    const metrics = agent.metrics;
    // Cache hit recorded but action still executed
    expect(metrics.cache.hits).toBe(1);
    // Only first write (result-only doesn't re-write on hit)
    expect(metrics.cache.writes).toBe(1);
  });

  it("'result-only' returns cached result after execution", async () => {
    const agent = await createAgentWithCache();
    const contextStub = {
      on: jest.fn(),
      off: jest.fn(),
    };
    const pageStub = {
      url: () => "https://example.com/action-result-only-return",
      on: jest.fn(),
      off: jest.fn(),
      context: () => contextStub,
    } as any;

    agent.currentPage = pageStub;

    // First execution
    mockRunAgentTask.mockResolvedValueOnce({
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "first-execution-output",
    });
    const first = await agent.executeTask(
      "Do action",
      { cacheStrategy: "result-only" },
      pageStub
    );
    await (agent as any).cacheManager.flushPending?.();

    // Second execution returns different output but we use cached result
    mockRunAgentTask.mockResolvedValueOnce({
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "second-execution-output",
    });
    const second = await agent.executeTask(
      "Do action",
      { cacheStrategy: "result-only" },
      pageStub
    );

    // Both calls executed
    expect(mockRunAgentTask).toHaveBeenCalledTimes(2);
    // First returns executed result
    expect(first.output).toBe("first-execution-output");
    // Second returns cached result (from first execution)
    expect(second.output).toBe("first-execution-output");
  });

  it("'result-only' calls onComplete with cached result", async () => {
    const agent = await createAgentWithCache();
    const contextStub = {
      on: jest.fn(),
      off: jest.fn(),
    };
    const pageStub = {
      url: () => "https://example.com/action-oncomplete",
      on: jest.fn(),
      off: jest.fn(),
      context: () => contextStub,
    } as any;

    agent.currentPage = pageStub;

    // First execution
    await agent.executeTask(
      "Submit form",
      { cacheStrategy: "result-only" },
      pageStub
    );
    await (agent as any).cacheManager.flushPending?.();

    // Second execution with onComplete
    const onComplete = jest.fn();
    await agent.executeTask(
      "Submit form",
      { cacheStrategy: "result-only", onComplete },
      pageStub
    );

    // onComplete should be called with cached result
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        status: TaskStatus.COMPLETED,
      })
    );
  });

  it("'result-only' surfaces failures instead of masking them with cached result", async () => {
    const agent = await createAgentWithCache();
    const contextStub = {
      on: jest.fn(),
      off: jest.fn(),
    };
    const pageStub = {
      url: () => "https://example.com/action-failure",
      on: jest.fn(),
      off: jest.fn(),
      context: () => contextStub,
    } as any;

    agent.currentPage = pageStub;

    // First execution succeeds and writes to cache
    mockRunAgentTask.mockResolvedValueOnce({
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "success-output",
    });
    await agent.executeTask(
      "Click button",
      { cacheStrategy: "result-only" },
      pageStub
    );
    await (agent as any).cacheManager.flushPending?.();

    // Second execution fails - should surface failure, not cached success
    mockRunAgentTask.mockResolvedValueOnce({
      status: TaskStatus.FAILED,
      steps: [],
      output: "failure-output",
    });
    const onComplete = jest.fn();
    const result = await agent.executeTask(
      "Click button",
      { cacheStrategy: "result-only", onComplete },
      pageStub
    );

    // Should return the failure, not the cached success
    expect(result.status).toBe(TaskStatus.FAILED);
    expect(result.output).toBe("failure-output");

    // onComplete should NOT be called on failure
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("'result-only' does not mark failure as cache hit in history", async () => {
    const agent = await createAgentWithCache();
    const contextStub = {
      on: jest.fn(),
      off: jest.fn(),
    };
    const pageStub = {
      url: () => "https://example.com/action-failure-history",
      on: jest.fn(),
      off: jest.fn(),
      context: () => contextStub,
    } as any;

    agent.currentPage = pageStub;

    // First execution succeeds
    mockRunAgentTask.mockResolvedValueOnce({
      status: TaskStatus.COMPLETED,
      steps: [],
      output: "success",
    });
    await agent.executeTask(
      "Do thing",
      { cacheStrategy: "result-only" },
      pageStub
    );
    await (agent as any).cacheManager.flushPending?.();

    // Second execution fails
    mockRunAgentTask.mockResolvedValueOnce({
      status: TaskStatus.FAILED,
      steps: [],
      output: "failed",
    });
    await agent.executeTask(
      "Do thing",
      { cacheStrategy: "result-only" },
      pageStub
    );

    // Check history - failure should NOT be marked as cache hit
    const history = agent.history;
    const lastEntry = history[history.length - 1];
    expect(lastEntry.cacheHit).toBe(false);
  });
});
