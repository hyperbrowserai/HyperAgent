import { z } from "zod";
import { HyperAgent } from "@/agent";
import { DEFAULT_ACTIONS } from "@/agent/actions";
import { SimpleChatModel } from "@langchain/core/language_models/chat_models";

describe("Completion validation default action", () => {
  class MockChatModel extends SimpleChatModel {
    constructor() {
      super({} as any);
    }

    _llmType(): string {
      return "mock";
    }

    async _call(
      _messages: any,
      _options: any,
      _runManager?: any
    ): Promise<string> {
      return "mock-response";
    }
  }

  const hasAction = (actions: Array<{ type: string }>, type: string) =>
    actions.some((action) => action.type === type);

  it("includes the completion validator in the default action registry", () => {
    expect(hasAction(DEFAULT_ACTIONS, "taskCompleteValidation")).toBe(true);
  });

  it("returns the completion validator from getActions without an output schema", async () => {
    const agent = new HyperAgent({ llm: new MockChatModel() as any });

    try {
      const actions = (agent as any).getActions();
      expect(hasAction(actions, "taskCompleteValidation")).toBe(true);
      expect(actions.filter((action: any) => action.type === "complete")).toHaveLength(1);
    } finally {
      await agent.closeAgent();
    }
  });

  it("returns the completion validator from getActions when an output schema is provided", async () => {
    const agent = new HyperAgent({ llm: new MockChatModel() as any });

    try {
      const schema = z.object({ foo: z.string() });
      const actions = (agent as any).getActions(schema);
      expect(hasAction(actions, "taskCompleteValidation")).toBe(true);
      expect(actions.filter((action: any) => action.type === "complete")).toHaveLength(1);
    } finally {
      await agent.closeAgent();
    }
  });
});
