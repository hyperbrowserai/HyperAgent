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
