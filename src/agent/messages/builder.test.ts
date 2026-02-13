import { buildAgentStepMessages } from "@/agent/messages/builder";
import type { AgentStep } from "@/types/agent/types";
import type { Page } from "playwright-core";

function createFakePage(url: string, urls: string[]): Page {
  return {
    url: () => url,
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
});
