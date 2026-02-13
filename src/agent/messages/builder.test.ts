import { buildAgentStepMessages } from "@/agent/messages/builder";
import type { AgentStep } from "@/types/agent/types";
import type { Page } from "playwright-core";

jest.mock("@/utils/retry", () => ({
  retry: jest.fn(),
}));

const { retry } = jest.requireMock("@/utils/retry") as {
  retry: jest.Mock;
};

function createFakePage(url: string, urls: string[]): Page {
  return {
    url: () => url,
    evaluate: jest.fn().mockResolvedValue({
      scrollY: 10,
      viewportHeight: 100,
      totalHeight: 500,
    }),
    context: () =>
      ({
        pages: () =>
          urls.map((tabUrl) => ({
            url: () => tabUrl,
          })),
      }) as ReturnType<Page["context"]>,
  } as unknown as Page;
}

function createStep(idx: number): AgentStep {
  return {
    idx,
    agentOutput: {
      thoughts: `thought-${idx}`,
      memory: `memory-${idx}`,
      action: {
        type: "wait",
        params: {
          reason: "test",
        },
      },
    },
    actionOutput: {
      success: true,
      message: "ok",
    },
  };
}

describe("buildAgentStepMessages", () => {
  beforeEach(() => {
    retry.mockImplementation(async ({ func }: { func: () => Promise<unknown> }) =>
      func()
    );
  });

  it("includes open tabs and variable values while trimming old step history", async () => {
    const steps = Array.from({ length: 12 }, (_, idx) => createStep(idx));
    const page = createFakePage("https://example.com/current", [
      "https://example.com/current",
      "https://example.com/other",
    ]);

    const messages = await buildAgentStepMessages(
      [{ role: "system", content: "system" }],
      steps,
      "task",
      page,
      {
        elements: new Map(),
        domState: "dom",
        xpathMap: {},
        backendNodeMap: {},
      },
      undefined,
      [
        {
          key: "email",
          value: "person@example.com",
          description: "User email",
        },
      ]
    );

    const joined = messages
      .map((message) =>
        typeof message.content === "string" ? message.content : ""
      )
      .join("\n");

    expect(joined).toContain("=== Open Tabs ===");
    expect(joined).toContain("person@example.com");
    expect(joined).toContain("older steps omitted");
    expect(joined).toContain("latest 10 of 12 steps");
    expect(joined).not.toContain("thought-0");
    expect(joined).toContain("thought-11");
  });

  it("does not crash when step extract payload is circular", async () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const step = createStep(0);
    step.actionOutput.extract = circular;
    const page = createFakePage("https://example.com/current", [
      "https://example.com/current",
    ]);

    const messages = await buildAgentStepMessages(
      [{ role: "system", content: "system" }],
      [step],
      "task",
      page,
      {
        elements: new Map(),
        domState: "dom",
        xpathMap: {},
        backendNodeMap: {},
      },
      undefined,
      []
    );

    const joined = messages
      .map((message) =>
        typeof message.content === "string" ? message.content : ""
      )
      .join("\n");

    expect(joined).toContain('"self":"[Circular]"');
  });

  it("falls back to zeroed page state when scroll info lookup fails", async () => {
    retry.mockRejectedValue({ reason: "scroll failed" });
    const page = createFakePage("https://example.com/current", [
      "https://example.com/current",
    ]);

    const messages = await buildAgentStepMessages(
      [{ role: "system", content: "system" }],
      [],
      "task",
      page,
      {
        elements: new Map(),
        domState: "dom",
        xpathMap: {},
        backendNodeMap: {},
      },
      "abc123",
      []
    );

    const screenshotMessage = messages.find(
      (message) => Array.isArray(message.content)
    );
    expect(screenshotMessage).toBeDefined();
    if (!screenshotMessage || !Array.isArray(screenshotMessage.content)) {
      return;
    }

    const textParts = screenshotMessage.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    expect(textParts).toContain("Pixels above: 0");
    expect(textParts).toContain("Pixels below: 0");
  });

  it("truncates oversized serialized payloads to protect prompt budget", async () => {
    const step = createStep(0);
    step.actionOutput.extract = { payload: "x".repeat(5000) };
    const page = createFakePage("https://example.com/current", [
      "https://example.com/current",
    ]);

    const messages = await buildAgentStepMessages(
      [{ role: "system", content: "system" }],
      [step],
      "task",
      page,
      {
        elements: new Map(),
        domState: "dom",
        xpathMap: {},
        backendNodeMap: {},
      },
      undefined,
      []
    );

    const joined = messages
      .map((message) =>
        typeof message.content === "string" ? message.content : ""
      )
      .join("\n");

    expect(joined).toContain("[truncated for prompt budget]");
    expect(joined.length).toBeLessThan(6000);
  });

  it("falls back to placeholder text when open tabs cannot be listed", async () => {
    const page = {
      url: () => "https://example.com/current",
      context: () => {
        throw new Error("context unavailable");
      },
    } as unknown as Page;

    const messages = await buildAgentStepMessages(
      [{ role: "system", content: "system" }],
      [],
      "task",
      page,
      {
        elements: new Map(),
        domState: "dom",
        xpathMap: {},
        backendNodeMap: {},
      },
      undefined,
      []
    );

    const joined = messages
      .map((message) =>
        typeof message.content === "string" ? message.content : ""
      )
      .join("\n");

    expect(joined).toContain("=== Open Tabs ===");
    expect(joined).toContain("Open tabs unavailable");
  });

  it("caps open-tab listing and reports omitted tab count", async () => {
    const urls = Array.from({ length: 25 }, (_, idx) => `https://example.com/${idx}`);
    const page = createFakePage("https://example.com/0", urls);

    const messages = await buildAgentStepMessages(
      [{ role: "system", content: "system" }],
      [],
      "task",
      page,
      {
        elements: new Map(),
        domState: "dom",
        xpathMap: {},
        backendNodeMap: {},
      },
      undefined,
      []
    );

    const joined = messages
      .map((message) =>
        typeof message.content === "string" ? message.content : ""
      )
      .join("\n");

    expect(joined).toContain("[19] https://example.com/19");
    expect(joined).toContain("... 5 more tabs omitted");
    expect(joined).not.toContain("[20] https://example.com/20");
  });

  it("truncates oversized thought, memory, and action output messages", async () => {
    const longText = "x".repeat(5000);
    const step = createStep(0);
    step.agentOutput.thoughts = longText;
    step.agentOutput.memory = longText;
    step.actionOutput.message = longText;
    const page = createFakePage("https://example.com/current", [
      "https://example.com/current",
    ]);

    const messages = await buildAgentStepMessages(
      [{ role: "system", content: "system" }],
      [step],
      "task",
      page,
      {
        elements: new Map(),
        domState: "dom",
        xpathMap: {},
        backendNodeMap: {},
      },
      undefined,
      []
    );

    const joined = messages
      .map((message) =>
        typeof message.content === "string" ? message.content : ""
      )
      .join("\n");

    expect(joined).toContain("[truncated for prompt budget]");
    expect(joined.length).toBeLessThan(9000);
  });
});
