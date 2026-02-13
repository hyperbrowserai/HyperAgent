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

  it("matches reserved keys case-insensitively after trimming", () => {
    expect(
      sanitizeProviderOptions(
        {
          " Model ": "override",
          " Messages ": "override",
          top_p: 0.8,
        },
        reserved
      )
    ).toEqual({
      top_p: 0.8,
    });
  });

  it("trims custom keys and discards empty keys", () => {
    expect(
      sanitizeProviderOptions(
        {
          "  top_p  ": 0.8,
          "   ": "empty",
        },
        reserved
      )
    ).toEqual({
      top_p: 0.8,
    });
  });

  it("sanitizes control characters in custom option keys", () => {
    expect(
      sanitizeProviderOptions(
        {
          "  top\n\tp  ": 0.7,
        },
        reserved
      )
    ).toEqual({
      "top p": 0.7,
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

  it("removes nested unsafe keys with surrounding whitespace", () => {
    const result = sanitizeProviderOptions(
      {
        metadata: {
          " __proto__ ": "bad",
          keep: true,
        },
      },
      reserved
    );

    expect(result).toEqual({
      metadata: {
        keep: true,
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

  it("normalizes bigint, symbol, and function values safely", () => {
    const symbolValue = Symbol("token");
    function sampleFunction(): void {
      return;
    }

    const result = sanitizeProviderOptions(
      {
        bigintValue: BigInt(42),
        symbolValue,
        functionValue: sampleFunction,
      },
      reserved
    );

    expect(result).toEqual({
      bigintValue: "42n",
      symbolValue: "Symbol(token)",
      functionValue: "[Function sampleFunction]",
    });
  });

  it("truncates oversized string option values", () => {
    const result = sanitizeProviderOptions(
      {
        metadata: "x".repeat(20_100),
      },
      reserved
    ) as Record<string, unknown>;

    expect(typeof result.metadata).toBe("string");
    expect(result.metadata as string).toContain("[truncated");
    expect((result.metadata as string).length).toBeLessThan(20_200);
  });

  it("returns deterministic marker for arrays that fail during traversal", () => {
    const trappedArray = new Proxy(["ok"], {
      get: (target, prop, receiver) => {
        if (prop === "map") {
          throw new Error("array map trap");
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const result = sanitizeProviderOptions(
      {
        metadata: trappedArray,
      },
      reserved
    );

    expect(result).toEqual({
      metadata: "[UnserializableArray: array map trap]",
    });
  });

  it("returns deterministic marker for objects that fail during entry traversal", () => {
    const trappedObject = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("entry trap");
        },
      }
    );

    const result = sanitizeProviderOptions(
      {
        metadata: trappedObject,
      },
      reserved
    );

    expect(result).toEqual({
      metadata: "[UnserializableObject: entry trap]",
    });
  });

  it("returns undefined when top-level options object entries are unreadable", () => {
    const trappedOptions = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("top-level entry trap");
        },
      }
    );

    expect(
      sanitizeProviderOptions(
        trappedOptions as unknown as Record<string, unknown>,
        reserved
      )
    ).toBeUndefined();
  });

  it("falls back safely when reserved-key iteration throws", () => {
    const trappedReservedKeys = new Proxy(
      new Set(["model"]),
      {
        get: (target, prop, receiver) => {
          if (prop === Symbol.iterator) {
            throw new Error("reserved iterator trap");
          }
          return Reflect.get(target, prop, receiver);
        },
      }
    );

    expect(
      sanitizeProviderOptions(
        {
          top_p: 0.8,
        },
        trappedReservedKeys as unknown as ReadonlySet<string>
      )
    ).toEqual({
      top_p: 0.8,
    });
  });

  it("caps excessive provider-option nesting depth", () => {
    const deeplyNested: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = deeplyNested;
    for (let depth = 0; depth < 30; depth += 1) {
      cursor.child = {};
      cursor = cursor.child as Record<string, unknown>;
    }

    const result = sanitizeProviderOptions(
      {
        metadata: deeplyNested,
      },
      reserved
    ) as Record<string, unknown>;

    let current = result.metadata as Record<string, unknown>;
    for (let depth = 0; depth < 19; depth += 1) {
      current = current.child as Record<string, unknown>;
      expect(typeof current).toBe("object");
    }

    expect(current.child).toBe("[MaxDepthExceeded]");
  });
});
