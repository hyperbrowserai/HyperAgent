import { PerformanceTracker } from "@/context-providers/a11y-dom/performance";

describe("PerformanceTracker diagnostics", () => {
  it("sanitizes and truncates timer-not-found diagnostics", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const tracker = new PerformanceTracker("root");

    try {
      tracker.stopTimer(`timer\u0000\n${"x".repeat(600)}`);

      const diagnostic = String(warnSpy.mock.calls[0]?.[0] ?? "");
      expect(diagnostic).toContain("[truncated");
      expect(diagnostic).not.toContain("\u0000");
      expect(diagnostic).not.toContain("\n");
      expect(diagnostic.length).toBeLessThan(500);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("sanitizes and truncates out-of-order timer diagnostics", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const tracker = new PerformanceTracker("root");
    const parentName = `parent\u0000\n${"p".repeat(300)}`;
    const childName = `child\u0000\n${"c".repeat(300)}`;

    try {
      tracker.startTimer(parentName);
      tracker.startTimer(childName);
      tracker.stopTimer(parentName);

      const diagnostic = String(warnSpy.mock.calls[0]?.[0] ?? "");
      expect(diagnostic).toContain("stopped out of order");
      expect(diagnostic).toContain("[truncated");
      expect(diagnostic).not.toContain("\u0000");
      expect(diagnostic).not.toContain("\n");
      expect(diagnostic.length).toBeLessThan(700);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
