import { SYSTEM_PROMPT } from "@/agent/messages/system-prompt";

describe("SYSTEM_PROMPT action contract", () => {
  it("does not advertise disabled navigation actions", () => {
    expect(SYSTEM_PROMPT).not.toContain("pageBack");
    expect(SYSTEM_PROMPT).not.toContain("pageForward");
  });

  it("uses the canonical chunk scrolling method names", () => {
    expect(SYSTEM_PROMPT).toContain("nextChunk");
    expect(SYSTEM_PROMPT).toContain("prevChunk");
    expect(SYSTEM_PROMPT).not.toContain("scrollNextChunk");
    expect(SYSTEM_PROMPT).not.toContain("scrollPrevChunk");
  });

  it("references canonical selectOptionFromDropdown interaction name", () => {
    expect(SYSTEM_PROMPT).toContain("selectOptionFromDropdown");
    expect(SYSTEM_PROMPT).not.toContain("click, fill, type, press, select,");
  });
});
