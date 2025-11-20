import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { HyperAgent } from "@/agent";
import { TaskStatus } from "@/types";
import { scopeDomWithSelector } from "@/context-providers/dom/selector-scope";
import { captureDOMState } from "@/agent/shared/dom-capture";
import { computeDomHash } from "@/context-providers/dom/dom-hash";
import { runAgentTask } from "@/agent/tools/agent";
import { z } from "zod";

jest.mock("uuid", () => ({ v4: () => "test-uuid" }));
jest.mock("@/agent/shared/dom-capture");
jest.mock("@/context-providers/dom/dom-hash");
jest.mock("@/context-providers/dom/selector-scope");
jest.mock("@/agent/tools/agent");

const mockCaptureDomState = captureDOMState as jest.MockedFunction<
  typeof captureDOMState
>;
const mockComputeDomHash = computeDomHash as jest.MockedFunction<
  typeof computeDomHash
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
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hyperagent-cache-"));
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
    mockComputeDomHash.mockResolvedValue("dom-hash-1");
    mockRunAgentTask.mockResolvedValue({
      status: TaskStatus.COMPLETED,
      steps: [],
      output: JSON.stringify("extracted-text"),
    });
  });

  it("reuses cached extract results and scopes DOM for selectors", async () => {
    const agent = await createAgentWithCache();
    const pageStub = {
      url: () => "https://example.com",
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
