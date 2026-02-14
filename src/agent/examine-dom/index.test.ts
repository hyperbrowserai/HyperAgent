import { examineDom, extractValueFromInstruction } from "@/agent/examine-dom";
import type { ExamineDomContext } from "@/agent/examine-dom/types";
import type { HyperAgentLLM } from "@/llm/types";

const createContext = (): ExamineDomContext => ({
  tree: "[0-1] button: Submit\n[0-2] textbox: Email",
  xpathMap: {
    "0-1": "//button[1]",
  },
  elements: new Map([
    [
      "0-2",
      {
        role: "textbox",
      },
    ],
  ]),
  url: "https://example.com",
});

const createLLM = (
  invokeStructured: jest.Mock
): HyperAgentLLM =>
  ({
    invoke: jest.fn(async () => ({ role: "assistant", content: "ok" })),
    invokeStructured,
    getProviderId: () => "mock",
    getModelId: () => "mock-model",
    getCapabilities: () => ({
      multimodal: false,
      toolCalling: true,
      jsonMode: true,
    }),
  }) as HyperAgentLLM;

describe("examineDom", () => {
  it("sorts by confidence and filters unknown element IDs", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const invokeStructured = jest.fn().mockResolvedValue({
        rawText: "{}",
        parsed: {
          elements: [
            { elementId: "0-missing", confidence: 0.99, reason: "nope" },
            { elementId: "0-1", confidence: 0.3, reason: "button" },
            { elementId: "0-2", confidence: 0.8, reason: "textbox" },
          ],
        },
      });

      const result = await examineDom(
        "click submit",
        createContext(),
        createLLM(invokeStructured)
      );

      expect(result.elements.map((entry) => entry.elementId)).toEqual([
        "0-2",
        "0-1",
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        "[examineDom] Element 0-missing not found in context, skipping"
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("returns empty elements when parsed payload is missing", async () => {
    const invokeStructured = jest.fn().mockResolvedValue({
      rawText: "raw",
      parsed: null,
    });

    const result = await examineDom(
      "find element",
      createContext(),
      createLLM(invokeStructured)
    );

    expect(result.elements).toEqual([]);
    expect(result.llmResponse).toEqual({
      rawText: "raw",
      parsed: null,
    });
  });

  it("returns empty elements when parsed element iteration traps", async () => {
    const trappedElements = new Proxy([], {
      get: (target, prop, receiver) => {
        if (prop === Symbol.iterator) {
          throw new Error("iterator trap");
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const invokeStructured = jest.fn().mockResolvedValue({
      rawText: "raw",
      parsed: {
        elements: trappedElements,
      },
    });

    const result = await examineDom(
      "find element",
      createContext(),
      createLLM(invokeStructured)
    );

    expect(result.elements).toEqual([]);
    expect(result.llmResponse.rawText).toBe("raw");
  });

  it("normalizes malformed parsed element entries safely", async () => {
    const invokeStructured = jest.fn().mockResolvedValue({
      rawText: "raw",
      parsed: {
        elements: [
          { elementId: " 0-2 ", confidence: "high", reason: 1 },
          { elementId: "", confidence: 1 },
          { confidence: 0.8 },
        ],
      },
    });

    const result = await examineDom(
      "find element",
      createContext(),
      createLLM(invokeStructured)
    );

    expect(result.elements).toEqual([
      {
        elementId: "0-2",
        description: "",
        confidence: 0,
        method: "click",
        arguments: [],
      },
    ]);
  });

  it("formats non-Error thrown values from invokeStructured", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const invokeStructured = jest
        .fn()
        .mockRejectedValue({ reason: "llm exploded" });

      const result = await examineDom(
        "find element",
        createContext(),
        createLLM(invokeStructured)
      );

      expect(result.elements).toEqual([]);
      expect(result.llmResponse).toEqual({ rawText: "", parsed: null });
      expect(errorSpy).toHaveBeenCalledWith(
        '[examineDom] Error finding elements: {"reason":"llm exploded"}'
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("sanitizes and truncates oversized examineDom diagnostics", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const invokeStructured = jest
        .fn()
        .mockRejectedValue(new Error(`llm\u0000\n${"x".repeat(10_000)}`));

      const result = await examineDom(
        "find element",
        createContext(),
        createLLM(invokeStructured)
      );

      expect(result.elements).toEqual([]);
      const diagnostic = String(errorSpy.mock.calls[0]?.[0] ?? "");
      expect(diagnostic).toContain("[truncated");
      expect(diagnostic).not.toContain("\u0000");
      expect(diagnostic).not.toContain("\n");
      expect(diagnostic.length).toBeLessThan(700);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("sanitizes and truncates missing-element warning identifiers", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const invokeStructured = jest.fn().mockResolvedValue({
        rawText: "{}",
        parsed: {
          elements: [
            {
              elementId: `missing\u0000\n${"x".repeat(400)}`,
              confidence: 0.99,
              reason: "nope",
            },
          ],
        },
      });

      const result = await examineDom(
        "click submit",
        createContext(),
        createLLM(invokeStructured)
      );

      expect(result.elements).toEqual([]);
      const warning = String(warnSpy.mock.calls[0]?.[0] ?? "");
      expect(warning).toContain("[truncated");
      expect(warning).not.toContain("\u0000");
      expect(warning).not.toContain("\n");
      expect(warning.length).toBeLessThan(500);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("extractValueFromInstruction", () => {
  it("extracts value from supported prepositions", () => {
    expect(extractValueFromInstruction("fill email with test@example.com")).toBe(
      "test@example.com"
    );
    expect(extractValueFromInstruction("type hello into search box")).toBe(
      "hello"
    );
    expect(extractValueFromInstruction("enter password123 in password field")).toBe(
      "password123"
    );
  });

  it("returns empty string when no value can be inferred", () => {
    expect(extractValueFromInstruction("click submit button")).toBe("");
    expect(extractValueFromInstruction("   ")).toBe("");
  });
});
