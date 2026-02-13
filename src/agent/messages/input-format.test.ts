import { INPUT_FORMAT } from "@/agent/messages/input-format";

describe("INPUT_FORMAT contract", () => {
  it("lists current URL before open tabs to match runtime message order", () => {
    const currentUrlIndex = INPUT_FORMAT.indexOf("=== Current URL ===");
    const openTabsIndex = INPUT_FORMAT.indexOf("=== Open Tabs ===");

    expect(currentUrlIndex).toBeGreaterThan(-1);
    expect(openTabsIndex).toBeGreaterThan(-1);
    expect(currentUrlIndex).toBeLessThan(openTabsIndex);
  });

  it("documents variable current-value payload shape", () => {
    expect(INPUT_FORMAT).toContain(
      "Format: <<name>> - {description} | current value: {json serialized value}"
    );
  });

  it("documents page state in the same order emitted by runtime", () => {
    const aboveIndex = INPUT_FORMAT.indexOf("- Pixels above:");
    const belowIndex = INPUT_FORMAT.indexOf("- Pixels below:");

    expect(aboveIndex).toBeGreaterThan(-1);
    expect(belowIndex).toBeGreaterThan(-1);
    expect(aboveIndex).toBeLessThan(belowIndex);
  });
});
