import { z } from "zod";
import { HyperAgent } from "@/agent";
import type { ActionType, AgentActionDefinition } from "@/types";
import type { HyperAgentLLM } from "@/llm/types";

const connectToServerMock = jest.fn();
const disconnectServerMock = jest.fn();
const disconnectMock = jest.fn();
const getServerIdsMock = jest.fn(() => []);
const getServerInfoMock = jest.fn(() => []);

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
});
