import {
  buildActionFailureMessage,
  getPageMethod,
  normalizeActionText,
} from "@/agent/actions/shared/action-runtime";

describe("action-runtime helpers", () => {
  it("normalizes control characters in action text inputs", () => {
    const normalized = normalizeActionText("hello\u0000\nworld", "fallback", 100);
    expect(normalized).toBe("hello world");
  });

  it("truncates oversized normalized action text inputs", () => {
    const normalized = normalizeActionText(`x${"y".repeat(1_000)}`, "fallback", 20);
    expect(normalized).toContain("…");
    expect(normalized.length).toBe(21);
  });

  it("formats action failure messages with sanitized diagnostics", () => {
    const message = buildActionFailureMessage(
      "run\u0000 action",
      new Error(`failed\n${"x".repeat(2_000)}`)
    );

    expect(message).toContain("Failed to run action:");
    expect(message).toContain("…");
    expect(message).not.toContain("\u0000");
    expect(message).not.toContain("\n");
  });

  it("returns null when page method is unavailable", () => {
    const method = getPageMethod({} as never, "goto");
    expect(method).toBeNull();
  });

  it("returns bound page methods when available", async () => {
    const page = {
      callCount: 0,
      goto(this: { callCount: number }, url: string): string {
        this.callCount += 1;
        return `navigated:${url}`;
      },
    };
    const method = getPageMethod({ page } as never, "goto");
    expect(typeof method).toBe("function");

    const result = await method?.("https://example.com");
    expect(result).toBe("navigated:https://example.com");
    expect(page.callCount).toBe(1);
  });
});
