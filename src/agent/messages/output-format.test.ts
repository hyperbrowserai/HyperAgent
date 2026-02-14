import { OUTPUT_FORMAT } from "@/agent/messages/output-format";
import { AGENT_ELEMENT_ACTIONS } from "@/agent/shared/action-restrictions";

describe("OUTPUT_FORMAT action contract", () => {
  it("lists every supported actElement method", () => {
    for (const method of AGENT_ELEMENT_ACTIONS) {
      expect(OUTPUT_FORMAT).toContain(method);
    }
  });

  it("does not mention legacy select method alias", () => {
    expect(OUTPUT_FORMAT).not.toContain("click, fill, type, press, select,");
    expect(OUTPUT_FORMAT).toContain("selectOptionFromDropdown");
  });
});
