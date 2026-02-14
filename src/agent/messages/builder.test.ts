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
    expect(joined).toContain("=== Earlier Actions Summary ===");
    expect(joined).toContain("Step 0: action=wait");
    expect(joined).not.toContain("thought-0");
    expect(joined).toContain("thought-11");
  });

  it("bounds omitted-step summary details for oversized histories", async () => {
    const page = createFakePage("https://example.com/current", [
      "https://example.com/current",
    ]);
    const steps = Array.from({ length: 25 }, (_, idx) => {
      const step = createStep(idx);
      step.actionOutput.message = `message-${idx} ${"x".repeat(2_000)}`;
      step.agentOutput.action.type = `action-${idx}-${"y".repeat(500)}`;
      return step;
    });

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
      []
    );

    const summaryMessage = messages.find(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes("=== Earlier Actions Summary ===")
    );
    expect(summaryMessage).toBeDefined();
    const summaryContent =
      typeof summaryMessage?.content === "string" ? summaryMessage.content : "";
    expect(summaryContent).toContain("[summary truncated");
    expect(summaryContent).toContain("Step 10");
    expect(summaryContent).not.toContain("Step 9");
    expect(summaryContent.length).toBeLessThan(2_200);
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

  it("handles step payloads with throwing getters", async () => {
    const trappedStep = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "agentOutput" || prop === "actionOutput") {
            throw new Error("step getter trap");
          }
          return undefined;
        },
      }
    );
    const page = createFakePage("https://example.com/current", [
      "https://example.com/current",
    ]);

    const messages = await buildAgentStepMessages(
      [{ role: "system", content: "system" }],
      [trappedStep as unknown as AgentStep],
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

    expect(joined).toContain("Thoughts unavailable");
    expect(joined).toContain("Memory unavailable");
    expect(joined).toContain("Action output unavailable");
  });

  it("falls back to no previous-actions section when step array length getter traps", async () => {
    const page = createFakePage("https://example.com/current", [
      "https://example.com/current",
    ]);
    const trappedSteps = new Proxy([createStep(0)], {
      get: (target, prop, receiver) => {
        if (prop === "length") {
          throw new Error("steps length trap");
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const messages = await buildAgentStepMessages(
      [{ role: "system", content: "system" }],
      trappedSteps as unknown as AgentStep[],
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

    expect(joined).not.toContain("=== Previous Actions ===");
    expect(joined).toContain("=== Final Goal ===");
  });

  it("ignores unreadable step array entries when index getter traps", async () => {
    const page = createFakePage("https://example.com/current", [
      "https://example.com/current",
    ]);
    const trappedSteps = new Proxy([createStep(0)], {
      get: (target, prop, receiver) => {
        if (prop === "0") {
          throw new Error("steps item trap");
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const messages = await buildAgentStepMessages(
      [{ role: "system", content: "system" }],
      trappedSteps as unknown as AgentStep[],
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

    expect(joined).not.toContain("=== Previous Actions ===");
    expect(joined).not.toContain("thought-0");
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

  it("falls back to placeholder text when current URL cannot be read", async () => {
    const page = {
      url: () => {
        throw new Error("url unavailable");
      },
      context: () =>
        ({
          pages: () => [],
        } as unknown as ReturnType<Page["context"]>),
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

    expect(joined).toContain("=== Current URL ===");
    expect(joined).toContain("Current URL unavailable");
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

  it("keeps open-tab summary when a tab URL lookup throws", async () => {
    const currentTab = { url: () => "https://example.com/current" };
    const badTab = {
      url: () => {
        throw new Error("tab url failure");
      },
    };
    const page = {
      url: () => "https://example.com/current",
      context: () =>
        ({
          pages: () => [currentTab, badTab],
        } as unknown as ReturnType<Page["context"]>),
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

    expect(joined).toContain("[0] https://example.com/current");
    expect(joined).toContain("[1] about:blank (url unavailable)");
  });

  it("truncates oversized tab URLs in open-tab summary", async () => {
    const longUrl = `https://example.com/${"x".repeat(2000)}`;
    const page = createFakePage(longUrl, [longUrl]);

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
    const openTabsSection = messages.find(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes("=== Open Tabs ===")
    );
    const tabLine =
      typeof openTabsSection?.content === "string"
        ? openTabsSection.content
            .split("\n")
            .find((line) => line.startsWith("[0]")) ?? ""
        : "";

    expect(joined).toContain("[tab url truncated]");
    expect(tabLine.length).toBeLessThanOrEqual(560);
  });

  it("sanitizes control characters in current URL and open tabs", async () => {
    const noisyUrl = "https://example.com/\u0007a\nb\tc";
    const page = createFakePage(noisyUrl, [noisyUrl]);

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

    expect(joined).toContain("https://example.com/ a b c");
    expect(joined).not.toContain("\u0007");
  });

  it("falls back to placeholder URL when sanitized tab URL is empty", async () => {
    const page = createFakePage("\u0007\n\t", ["\u0007\n\t"]);

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

    expect(joined).toContain("about:blank (url unavailable)");
  });

  it("includes current tab in summary even when beyond tab cap", async () => {
    const tabs = Array.from({ length: 25 }, (_, idx) => ({
      url: () => `https://example.com/${idx}`,
    }));
    const currentPage = tabs[24] as {
      url: () => string;
      context?: () => ReturnType<Page["context"]>;
    };
    currentPage.context = () =>
      ({
        pages: () => tabs,
      } as unknown as ReturnType<Page["context"]>);

    const messages = await buildAgentStepMessages(
      [{ role: "system", content: "system" }],
      [],
      "task",
      currentPage as unknown as Page,
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

    expect(joined).toContain("[24] https://example.com/24 (current)");
    expect(joined).toContain("... 5 more tabs omitted");
    expect(joined).not.toContain("[19] https://example.com/19");
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

  it("sanitizes control characters in step and DOM prompt content", async () => {
    const step = createStep(0);
    step.agentOutput.thoughts = "thought\u0000with\u0007control";
    step.agentOutput.memory = "memory\u0000with\u0007control";
    step.actionOutput.message = "result\u0000with\u0007control";
    const page = createFakePage("https://example.com/current", [
      "https://example.com/current",
    ]);

    const messages = await buildAgentStepMessages(
      [{ role: "system", content: "system" }],
      [step],
      "task\u0000value",
      page,
      {
        elements: new Map(),
        domState: "dom\u0000state\u0007payload",
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

    expect(joined).toContain("thought with control");
    expect(joined).toContain("memory with control");
    expect(joined).toContain("result with control");
    expect(joined).toContain("task value");
    expect(joined).toContain("dom state payload");
    expect(joined).not.toContain("\u0000");
    expect(joined).not.toContain("\u0007");
  });

  it("truncates oversized task goal and variable descriptions", async () => {
    const page = createFakePage("https://example.com/current", [
      "https://example.com/current",
    ]);

    const messages = await buildAgentStepMessages(
      [{ role: "system", content: "system" }],
      [],
      "g".repeat(5000),
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
          key: "token",
          value: "abc",
          description: "d".repeat(5000),
        },
      ]
    );

    const joined = messages
      .map((message) =>
        typeof message.content === "string" ? message.content : ""
      )
      .join("\n");

    expect(joined).toContain("[truncated for prompt budget]");
    expect(joined).not.toContain("g".repeat(3000));
    expect(joined).not.toContain("d".repeat(3000));
  });

  it("handles variables with throwing getters without crashing", async () => {
    const page = createFakePage("https://example.com/current", [
      "https://example.com/current",
    ]);
    const brokenVariable = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "key" || prop === "description" || prop === "value") {
            throw new Error("variable getter trap");
          }
          return undefined;
        },
      }
    );

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
      [brokenVariable as unknown as { key: string; value: string; description: string }]
    );

    const joined = messages
      .map((message) =>
        typeof message.content === "string" ? message.content : ""
      )
      .join("\n");

    expect(joined).toContain("<<variable_1>>");
    expect(joined).toContain("Variable description unavailable");
    expect(joined).toContain("[variable value unavailable]");
  });

  it("caps variable entries for prompt budget and reports omitted count", async () => {
    const page = createFakePage("https://example.com/current", [
      "https://example.com/current",
    ]);
    const variables = Array.from({ length: 35 }, (_, index) => ({
      key: `var_${index}`,
      value: `value_${index}`,
      description: `description ${index}`,
    }));

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
      variables
    );

    const joined = messages
      .map((message) =>
        typeof message.content === "string" ? message.content : ""
      )
      .join("\n");

    expect(joined).toContain("<<var_0>>");
    expect(joined).toContain("<<var_24>>");
    expect(joined).not.toContain("<<var_25>>");
    expect(joined).toContain("... 10 more variables omitted for context budget");
  });

  it("falls back to empty variable section when array length getter traps", async () => {
    const page = createFakePage("https://example.com/current", [
      "https://example.com/current",
    ]);
    const trappedVariables = new Proxy(
      [
        {
          key: "token",
          value: "abc",
          description: "desc",
        },
      ],
      {
        get: (target, prop, receiver) => {
          if (prop === "length") {
            throw new Error("length trap");
          }
          return Reflect.get(target, prop, receiver);
        },
      }
    );

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
      trappedVariables as unknown as Parameters<typeof buildAgentStepMessages>[6]
    );

    const joined = messages
      .map((message) =>
        typeof message.content === "string" ? message.content : ""
      )
      .join("\n");

    expect(joined).toContain("=== Variables ===");
    expect(joined).toContain("No variables set");
  });

  it("truncates oversized DOM state payloads", async () => {
    const page = createFakePage("https://example.com/current", [
      "https://example.com/current",
    ]);
    const hugeDomState = "d".repeat(70_000);

    const messages = await buildAgentStepMessages(
      [{ role: "system", content: "system" }],
      [],
      "task",
      page,
      {
        elements: new Map(),
        domState: hugeDomState,
        xpathMap: {},
        backendNodeMap: {},
      },
      undefined,
      []
    );

    const elementsMessage = messages.find(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes("=== Elements ===")
    );

    expect(typeof elementsMessage?.content).toBe("string");
    const content = elementsMessage?.content as string;
    expect(content).toContain("[DOM truncated for prompt budget]");
    expect(content.length).toBeLessThan(51_000);
  });

  it("falls back when domState payload getter throws", async () => {
    const page = createFakePage("https://example.com/current", [
      "https://example.com/current",
    ]);
    const trappedDomState = new Proxy(
      {
        elements: new Map(),
        xpathMap: {},
        backendNodeMap: {},
      },
      {
        get: (target, prop, receiver) => {
          if (prop === "domState") {
            throw new Error("domState getter trap");
          }
          return Reflect.get(target, prop, receiver);
        },
      }
    );

    const messages = await buildAgentStepMessages(
      [{ role: "system", content: "system" }],
      [],
      "task",
      page,
      trappedDomState as unknown as Parameters<typeof buildAgentStepMessages>[4],
      undefined,
      []
    );

    const joined = messages
      .map((message) =>
        typeof message.content === "string" ? message.content : ""
      )
      .join("\n");

    expect(joined).toContain("=== Elements ===");
    expect(joined).toContain("DOM state unavailable");
  });
});
