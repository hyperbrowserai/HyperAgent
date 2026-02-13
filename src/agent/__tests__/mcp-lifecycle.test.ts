import { z } from "zod";
import { HyperAgent } from "@/agent";
import type { ActionType, AgentActionDefinition } from "@/types";
import type { HyperAgentLLM } from "@/llm/types";

const connectToServerMock = jest.fn();
const disconnectServerMock = jest.fn();
const disconnectMock = jest.fn();
const getServerIdsMock: jest.Mock<string[], []> = jest.fn(() => []);
const getServerInfoMock: jest.Mock<
  Array<{ id: string; toolCount: number; toolNames: string[] }>,
  []
> = jest.fn(() => []);

jest.mock("@/agent/mcp/client", () => ({
  MCPClient: jest.fn().mockImplementation(() => ({
    connectToServer: connectToServerMock,
    disconnectServer: disconnectServerMock,
    disconnect: disconnectMock,
    getServerIds: getServerIdsMock,
    getServerInfo: getServerInfoMock,
  })),
}));

function createMockLLM(): HyperAgentLLM {
  return {
    invoke: async () => ({
      role: "assistant",
      content: "ok",
    }),
    invokeStructured: async () => ({
      rawText: "{}",
      parsed: null,
    }),
    getProviderId: () => "mock",
    getModelId: () => "mock-model",
    getCapabilities: () => ({
      multimodal: false,
      toolCalling: true,
      jsonMode: true,
    }),
  };
}

function createAction(
  type: string,
  label: string
): AgentActionDefinition<z.ZodObject<{}>> {
  return {
    type,
    actionParams: z.object({}),
    run: async () => ({
      success: true,
      message: "ok",
    }),
    pprintAction: () => label,
  };
}

describe("MCP lifecycle action registration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    connectToServerMock.mockReset();
    disconnectServerMock.mockReset();
    disconnectMock.mockReset();
    getServerIdsMock.mockReset();
    getServerInfoMock.mockReset();
    getServerIdsMock.mockReturnValue([]);
    getServerInfoMock.mockReturnValue([]);
    disconnectServerMock.mockResolvedValue(undefined);
    disconnectMock.mockResolvedValue(undefined);
  });

  it("registers MCP actions and removes them when server disconnects", async () => {
    const mcpAction = createAction("mcp_custom_action", "custom");
    connectToServerMock.mockResolvedValue({
      serverId: "server-1",
      actions: [mcpAction],
    });

    const agent = new HyperAgent({ llm: createMockLLM() });
    const serverId = await agent.connectToMCPServer({
      command: "echo",
    });

    expect(serverId).toBe("server-1");
    expect(
      agent.pprintAction({
        type: "mcp_custom_action",
        params: {},
      } as ActionType)
    ).toBe("custom");

    getServerIdsMock.mockReturnValue(["server-1"]);
    const disconnected = agent.disconnectFromMCPServer("server-1");
    expect(disconnected).toBe(true);
    expect(disconnectServerMock).toHaveBeenCalledWith("server-1");
    expect(
      agent.pprintAction({
        type: "mcp_custom_action",
        params: {},
      } as ActionType)
    ).toBe("");
  });

  it("rolls back partially registered MCP actions on registration failure", async () => {
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const uniqueAction = createAction("mcp_unique_action", "unique");
      const duplicateAction = createAction("goToUrl", "duplicate");
      connectToServerMock.mockResolvedValue({
        serverId: "server-2",
        actions: [uniqueAction, duplicateAction],
      });

      const agent = new HyperAgent({ llm: createMockLLM() });
      const connected = await agent.connectToMCPServer({
        command: "echo",
      });

      expect(connected).toBeNull();
      expect(disconnectServerMock).toHaveBeenCalledWith("server-2");
      expect(
        agent.pprintAction({
          type: "mcp_unique_action",
          params: {},
        } as ActionType)
      ).toBe("");
      expect(consoleErrorSpy).toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("returns false when disconnect is requested for unknown MCP server", async () => {
    connectToServerMock.mockResolvedValue({
      serverId: "server-a",
      actions: [],
    });
    const agent = new HyperAgent({ llm: createMockLLM() });
    await agent.connectToMCPServer({ command: "echo" });

    getServerIdsMock.mockReturnValue(["server-a"]);
    const disconnected = agent.disconnectFromMCPServer("missing-server");

    expect(disconnected).toBe(false);
    expect(disconnectServerMock).not.toHaveBeenCalled();
  });

  it("supports awaited MCP disconnect with async API", async () => {
    const action = createAction("mcp_async_action", "async");
    connectToServerMock.mockResolvedValue({
      serverId: "server-async",
      actions: [action],
    });
    const agent = new HyperAgent({ llm: createMockLLM() });
    await agent.connectToMCPServer({ command: "echo" });

    getServerIdsMock.mockReturnValue(["server-async"]);
    const disconnected = await agent.disconnectFromMCPServerAsync(
      "server-async"
    );

    expect(disconnected).toBe(true);
    expect(disconnectServerMock).toHaveBeenCalledWith("server-async");
    expect(
      agent.pprintAction({ type: "mcp_async_action", params: {} } as ActionType)
    ).toBe("");
  });

  it("returns false from async disconnect when transport cleanup fails", async () => {
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const action = createAction("mcp_async_fail_action", "async-fail");
      connectToServerMock.mockResolvedValue({
        serverId: "server-async-fail",
        actions: [action],
      });
      disconnectServerMock.mockRejectedValueOnce(new Error("disconnect failed"));

      const agent = new HyperAgent({ llm: createMockLLM() });
      await agent.connectToMCPServer({ command: "echo" });
      getServerIdsMock.mockReturnValue(["server-async-fail"]);

      const disconnected = await agent.disconnectFromMCPServerAsync(
        "server-async-fail"
      );

      expect(disconnected).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(
        agent.pprintAction({
          type: "mcp_async_fail_action",
          params: {},
        } as ActionType)
      ).toBe("");
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("reinitializing MCP client removes previous MCP action registrations", async () => {
    const actionA = createAction("mcp_action_a", "a");
    const actionB = createAction("mcp_action_b", "b");

    connectToServerMock
      .mockResolvedValueOnce({
        serverId: "server-a",
        actions: [actionA],
      })
      .mockResolvedValueOnce({
        serverId: "server-b",
        actions: [actionB],
      });

    const agent = new HyperAgent({ llm: createMockLLM() });
    await agent.connectToMCPServer({ command: "echo" });
    expect(
      agent.pprintAction({ type: "mcp_action_a", params: {} } as ActionType)
    ).toBe("a");

    await agent.initializeMCPClient({
      servers: [{ command: "echo", id: "server-b" }],
    });

    expect(disconnectMock).toHaveBeenCalledTimes(1);
    expect(
      agent.pprintAction({ type: "mcp_action_a", params: {} } as ActionType)
    ).toBe("");
    expect(
      agent.pprintAction({ type: "mcp_action_b", params: {} } as ActionType)
    ).toBe("b");
  });

  it("closeAgent tolerates MCP disconnect failures and clears MCP actions", async () => {
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    try {
      const action = createAction("mcp_close_action", "close");
      connectToServerMock.mockResolvedValue({
        serverId: "server-close",
        actions: [action],
      });
      disconnectMock.mockRejectedValueOnce(new Error("close disconnect failed"));

      const agent = new HyperAgent({ llm: createMockLLM() });
      await agent.connectToMCPServer({ command: "echo" });
      expect(
        agent.pprintAction({ type: "mcp_close_action", params: {} } as ActionType)
      ).toBe("close");

      await expect(agent.closeAgent()).resolves.toBeUndefined();

      expect(consoleWarnSpy).toHaveBeenCalled();
      expect(
        agent.pprintAction({ type: "mcp_close_action", params: {} } as ActionType)
      ).toBe("");
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });
});
