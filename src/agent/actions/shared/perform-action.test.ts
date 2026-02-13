import type { Page } from "playwright-core";
import { performAction } from "@/agent/actions/shared/perform-action";
import type { ActionContext } from "@/types";

jest.mock("../../shared/element-locator", () => ({
  getElementLocator: jest.fn(),
}));

jest.mock("../../shared/execute-playwright-method", () => ({
  executePlaywrightMethod: jest.fn(),
}));

const { getElementLocator } = jest.requireMock(
  "../../shared/element-locator"
) as {
  getElementLocator: jest.Mock;
};
const { executePlaywrightMethod } = jest.requireMock(
  "../../shared/execute-playwright-method"
) as {
  executePlaywrightMethod: jest.Mock;
};

describe("performAction variable interpolation", () => {
  const createContext = (overrides?: Partial<ActionContext>): ActionContext => ({
    page: {} as Page,
    domState: {
      elements: new Map([
        [
          "0-1",
          {
            role: "textbox",
          },
        ],
      ]),
      domState: "",
      xpathMap: { "0-1": "//input[1]" },
      backendNodeMap: {},
    },
    llm: {
      invoke: async () => ({ role: "assistant", content: "ok" }),
      invokeStructured: async () => ({ rawText: "{}", parsed: null }),
      getProviderId: () => "mock",
      getModelId: () => "mock-model",
      getCapabilities: () => ({
        multimodal: false,
        toolCalling: true,
        jsonMode: true,
      }),
    },
    tokenLimit: 10000,
    variables: [],
    cdpActions: false,
    invalidateDomCache: jest.fn(),
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    getElementLocator.mockResolvedValue({
      locator: {},
      xpath: "//input[1]",
    });
    executePlaywrightMethod.mockResolvedValue(undefined);
  });

  it("interpolates variables in instruction and method arguments", async () => {
    const context = createContext({
      variables: [
        {
          key: "email",
          value: "person@example.com",
          description: "Email address",
        },
      ],
    });

    const result = await performAction(context, {
      elementId: "0-1",
      method: "fill",
      arguments: ["<<email>>"],
      instruction: "Fill input with <<email>>",
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("person@example.com");
    expect(executePlaywrightMethod).toHaveBeenCalledWith(
      "fill",
      ["person@example.com"],
      {},
      expect.objectContaining({ clickTimeout: 3500 })
    );
  });

  it("interpolates variables when token keys include surrounding whitespace", async () => {
    const context = createContext({
      variables: [
        {
          key: "email",
          value: "person@example.com",
          description: "Email address",
        },
      ],
    });

    const result = await performAction(context, {
      elementId: "0-1",
      method: "fill",
      arguments: ["<< email >>"],
      instruction: "Fill input with << email >>",
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("person@example.com");
    expect(executePlaywrightMethod).toHaveBeenCalledWith(
      "fill",
      ["person@example.com"],
      {},
      expect.objectContaining({ clickTimeout: 3500 })
    );
  });

  it("formats non-Error failures from Playwright execution", async () => {
    executePlaywrightMethod.mockRejectedValue({ reason: "playwright failed" });

    const context = createContext();

    const result = await performAction(context, {
      elementId: "0-1",
      method: "fill",
      arguments: ["value"],
      instruction: "Fill input",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('{"reason":"playwright failed"}');
  });

  it("sanitizes and truncates oversized Playwright failure diagnostics", async () => {
    const hugeFailure = `playwright\u0000\n${"x".repeat(5_000)}`;
    executePlaywrightMethod.mockRejectedValue(new Error(hugeFailure));

    const context = createContext();

    const result = await performAction(context, {
      elementId: "0-1",
      method: "fill",
      arguments: ["value"],
      instruction: "Fill input",
    });

    expect(result.success).toBe(false);
    expect(result.message).not.toContain("\u0000");
    expect(result.message).not.toContain("\n");
    expect(result.message).toContain("…");
    expect(result.message.length).toBeLessThan(1_200);
  });

  it("defaults to empty method arguments when params.arguments is invalid", async () => {
    const context = createContext();

    const result = await performAction(context, {
      elementId: "0-1",
      method: "click",
      arguments: "not-an-array" as unknown as string[],
      instruction: "Click submit",
    });

    expect(result.success).toBe(true);
    expect(executePlaywrightMethod).toHaveBeenCalledWith(
      "click",
      [],
      {},
      expect.objectContaining({ clickTimeout: 3500 })
    );
  });

  it("handles unreadable variables without crashing interpolation", async () => {
    const variable = {
      description: "bad var",
      get key(): string {
        throw new Error("key trap");
      },
      get value(): string {
        throw new Error("value trap");
      },
    };
    const context = createContext({
      variables: [variable as unknown as ActionContext["variables"][number]],
    });

    const result = await performAction(context, {
      elementId: "0-1",
      method: "fill",
      arguments: ["<<email>>"],
      instruction: "Fill input with <<email>>",
    });

    expect(result.success).toBe(true);
    expect(executePlaywrightMethod).toHaveBeenCalledWith(
      "fill",
      ["<<email>>"],
      {},
      expect.objectContaining({ clickTimeout: 3500 })
    );
  });

  it("returns readable failure when DOM elements map is unavailable", async () => {
    const baseContext = createContext();
    const context = createContext({
      domState: {
        ...baseContext.domState,
        elements:
          undefined as unknown as ActionContext["domState"]["elements"],
      } as ActionContext["domState"],
    });

    const result = await performAction(context, {
      elementId: "0-1",
      method: "click",
      arguments: [],
      instruction: "Click submit",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("current DOM elements are unavailable");
  });

  it("falls back to Playwright when CDP hooks are invalid", async () => {
    const invalidCdp = {
      client: {} as unknown,
      resolveElement: "invalid",
      dispatchCDPAction: "invalid",
    } as unknown as NonNullable<ActionContext["cdp"]>;
    const context = createContext({
      cdpActions: true,
      cdp: invalidCdp,
    });

    const result = await performAction(context, {
      elementId: "0-1",
      method: "click",
      arguments: [],
      instruction: "Click submit",
    });

    expect(result.success).toBe(true);
    expect(executePlaywrightMethod).toHaveBeenCalledTimes(1);
  });
});
