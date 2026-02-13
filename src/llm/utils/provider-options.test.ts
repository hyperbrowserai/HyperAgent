import { sanitizeProviderOptions } from "@/llm/utils/provider-options";

describe("sanitizeProviderOptions", () => {
  const reserved = new Set(["model", "messages", "max_tokens"]);

  it("returns undefined for non-object provider options", () => {
    expect(sanitizeProviderOptions(undefined, reserved)).toBeUndefined();
    expect(sanitizeProviderOptions("oops", reserved)).toBeUndefined();
    expect(sanitizeProviderOptions([], reserved)).toBeUndefined();
  });

  it("removes reserved keys and keeps custom options", () => {
    expect(
      sanitizeProviderOptions(
        {
          model: "override",
          messages: "override",
          max_tokens: 999,
          top_p: 0.9,
          frequency_penalty: 0.2,
        },
        reserved
      )
    ).toEqual({
      top_p: 0.9,
      frequency_penalty: 0.2,
    });
  });

  it("returns undefined when all keys are reserved", () => {
    expect(
      sanitizeProviderOptions(
        {
          model: "override",
          messages: "override",
        },
        reserved
      )
    ).toBeUndefined();
  });

  it("drops unsafe prototype-like keys", () => {
    const options = {
      ["__proto__"]: { polluted: true },
      constructor: "bad",
      prototype: "bad",
      top_p: 0.95,
    };

    expect(
      sanitizeProviderOptions(options, reserved)
    ).toEqual({
      top_p: 0.95,
    });
  });

  it("recursively removes unsafe keys from nested objects", () => {
    const result = sanitizeProviderOptions(
      {
        top_p: 0.95,
        metadata: {
          safe: "ok",
          constructor: "bad",
          nested: {
            ["__proto__"]: "bad",
            keep: true,
          },
        },
      },
      reserved
    );

    expect(result).toEqual({
      top_p: 0.95,
      metadata: {
        safe: "ok",
        nested: {
          keep: true,
        },
      },
    });
  });

  it("replaces circular nested values with safe marker", () => {
    const circular: Record<string, unknown> = { id: "node" };
    circular.self = circular;

    const result = sanitizeProviderOptions(
      {
        metadata: circular,
      },
      reserved
    );

    expect(result).toEqual({
      metadata: {
        id: "node",
        self: "[Circular]",
      },
    });
  });

  it("replaces circular arrays with safe markers", () => {
    const circularArray: unknown[] = [];
    circularArray.push(circularArray);

    const result = sanitizeProviderOptions(
      {
        list: circularArray,
      },
      reserved
    );

    expect(result).toEqual({
      list: ["[Circular]"],
    });
  });

  it("preserves non-plain objects like Date values", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const result = sanitizeProviderOptions(
      {
        metadata: {
          createdAt,
        },
      },
      reserved
    );

    expect(result).toEqual({
      metadata: {
        createdAt,
      },
    });
  });
});
