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
  beforeEach(() => {
    jest.clearAllMocks();
    getElementLocator.mockResolvedValue({
      locator: {},
      xpath: "//input[1]",
    });
    executePlaywrightMethod.mockResolvedValue(undefined);
  });

  it("interpolates variables in instruction and method arguments", async () => {
    const context: ActionContext = {
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
      variables: [
        {
          key: "email",
          value: "person@example.com",
          description: "Email address",
        },
      ],
      cdpActions: false,
      invalidateDomCache: jest.fn(),
    };

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

  it("formats non-Error failures from Playwright execution", async () => {
    executePlaywrightMethod.mockRejectedValue({ reason: "playwright failed" });

    const context: ActionContext = {
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
    };

    const result = await performAction(context, {
      elementId: "0-1",
      method: "fill",
      arguments: ["value"],
      instruction: "Fill input",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('{"reason":"playwright failed"}');
  });
});
