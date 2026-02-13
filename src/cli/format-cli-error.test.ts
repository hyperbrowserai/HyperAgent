import { formatCliError } from "@/cli/format-cli-error";

describe("formatCliError", () => {
  it("formats object errors as readable JSON", () => {
    expect(formatCliError({ reason: "failure" })).toBe('{"reason":"failure"}');
  });

  it("falls back to generic message for empty error text", () => {
    expect(formatCliError("   ")).toBe("Unknown CLI error");
  });
});
