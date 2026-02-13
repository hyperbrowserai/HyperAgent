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
});
