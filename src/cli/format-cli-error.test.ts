import { formatCliError } from "@/cli/format-cli-error";

describe("formatCliError", () => {
  it("formats object errors as readable JSON", () => {
    expect(formatCliError({ reason: "failure" })).toBe('{"reason":"failure"}');
  });

  it("falls back to generic message for empty error text", () => {
    expect(formatCliError("   ")).toBe("Unknown CLI error");
  });

  it("sanitizes control characters from CLI error output", () => {
    expect(formatCliError("bad\u0007error\nmessage")).toBe("bad error message");
  });

  it("truncates oversized CLI error payloads", () => {
    const oversized = `error-${"x".repeat(3_000)}`;
    const result = formatCliError(oversized);

    expect(result).toContain("[truncated");
    expect(result.length).toBeLessThan(2_100);
  });
});
