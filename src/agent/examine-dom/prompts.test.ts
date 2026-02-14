import {
  buildActionInstruction,
  buildExamineDomSystemPrompt,
  buildExamineDomUserPrompt,
} from "@/agent/examine-dom/prompts";

describe("examine-dom prompts", () => {
  it("constrains action instruction to supported methods only", () => {
    const prompt = buildActionInstruction("click the login button");

    expect(prompt).toContain("using ONLY one of these methods");
    expect(prompt).toContain("selectOptionFromDropdown");
    expect(prompt).toContain("Do not use any other Playwright locator/action method.");
    expect(prompt).not.toContain("or any other playwright locator method");
  });

  it("builds a user prompt that includes instruction and tree", () => {
    const prompt = buildExamineDomUserPrompt(
      "fill email",
      "[0-1] textbox: Email"
    );

    expect(prompt).toContain("instruction:");
    expect(prompt).toContain("Accessibility Tree:");
    expect(prompt).toContain("[0-1] textbox: Email");
  });

  it("keeps system prompt focused on matching elements", () => {
    const prompt = buildExamineDomSystemPrompt();

    expect(prompt).toContain("Return an array of elements");
    expect(prompt).toContain("hierarchical accessibility tree");
  });
});
