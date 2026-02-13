import { formatUnknownError } from "@/utils";

describe("formatUnknownError", () => {
  it("returns message for Error instances", () => {
    expect(formatUnknownError(new Error("boom"))).toBe("boom");
  });

  it("falls back to error name when message is empty", () => {
    expect(formatUnknownError(new Error("   "))).toBe("Error");
  });

  it("returns strings unchanged", () => {
    expect(formatUnknownError("plain error")).toBe("plain error");
  });

  it("serializes plain objects", () => {
    expect(formatUnknownError({ reason: "bad" })).toBe('{"reason":"bad"}');
  });

  it("falls back to string conversion when JSON serialization fails", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(formatUnknownError(circular)).toBe('{"self":"[Circular]"}');
  });

  it("serializes bigint values to readable strings", () => {
    expect(formatUnknownError({ value: 42n })).toBe('{"value":"42n"}');
  });
});
