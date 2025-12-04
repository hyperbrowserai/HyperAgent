import {
  normalizeInstruction,
  computeInstructionHash,
  areInstructionsSimilar,
} from "./instruction-similarity";

describe("Instruction Similarity", () => {
  describe("normalizeInstruction", () => {
    it("lowercases and removes punctuation", () => {
      expect(normalizeInstruction("Get Prices!")).toBe("price");
    });

    it("removes stop words", () => {
      expect(normalizeInstruction("Get the prices")).toBe("price");
      expect(normalizeInstruction("Find the product prices")).toBe(
        "price product"
      );
    });

    it("stems plural words", () => {
      expect(normalizeInstruction("prices")).toBe("price");
      expect(normalizeInstruction("products")).toBe("product");
      expect(normalizeInstruction("boxes")).toBe("box");
      expect(normalizeInstruction("categories")).toBe("category");
    });

    it("stems verb forms", () => {
      expect(normalizeInstruction("clicking")).toBe("click");
      expect(normalizeInstruction("clicked")).toBe("click");
    });

    it("sorts words alphabetically", () => {
      expect(normalizeInstruction("prices products")).toBe("price product");
      expect(normalizeInstruction("product price")).toBe("price product");
    });

    it("removes duplicate words after stemming", () => {
      expect(normalizeInstruction("price prices")).toBe("price");
    });

    it("handles extra whitespace", () => {
      expect(normalizeInstruction("  Get   prices  ")).toBe("price");
    });
  });

  describe("semantic equivalence", () => {
    it("matches semantically similar instructions", () => {
      expect(areInstructionsSimilar("Get product prices", "Get the prices of products")).toBe(true);
      expect(areInstructionsSimilar("Click the submit button", "Click submit button")).toBe(true);
      expect(areInstructionsSimilar("Find all links", "Find the links")).toBe(true);
    });

    it("does not match semantically different instructions", () => {
      expect(areInstructionsSimilar("Get prices", "Get reviews")).toBe(false);
      expect(areInstructionsSimilar("Click submit", "Click cancel")).toBe(false);
      expect(areInstructionsSimilar("Find links", "Find buttons")).toBe(false);
    });

    it("handles case insensitivity", () => {
      expect(areInstructionsSimilar("GET PRICES", "get prices")).toBe(true);
      expect(areInstructionsSimilar("Click Button", "click button")).toBe(true);
    });

    it("handles punctuation differences", () => {
      expect(areInstructionsSimilar("Get prices.", "Get prices")).toBe(true);
      expect(areInstructionsSimilar("What's the price?", "what is the price")).toBe(true);
    });
  });

  describe("computeInstructionHash", () => {
    it("produces same hash for semantically similar instructions", () => {
      const hash1 = computeInstructionHash("Get product prices");
      const hash2 = computeInstructionHash("Get the prices of products");

      expect(hash1).toBe(hash2);
    });

    it("produces different hash for different instructions", () => {
      const hash1 = computeInstructionHash("Get prices");
      const hash2 = computeInstructionHash("Get reviews");

      expect(hash1).not.toBe(hash2);
    });

    it("is deterministic", () => {
      const instruction = "Extract product information";
      const hash1 = computeInstructionHash(instruction);
      const hash2 = computeInstructionHash(instruction);

      expect(hash1).toBe(hash2);
    });
  });

  describe("real-world instruction pairs", () => {
    // These pairs have the same words just rearranged/with different stop words
    const equivalentPairs = [
      ["Get product prices", "Get the prices of products"],
      ["Extract all links from the page", "Extract the links on the page"],
      ["Click the login button", "Click on login button"],
      ["Fill in the email field", "Fill the email field"],
      ["Find navigation menu", "Find the navigation menu"],
      ["Get items in cart", "Get the cart items"],
    ];

    equivalentPairs.forEach(([a, b]) => {
      it(`"${a}" should match "${b}"`, () => {
        expect(areInstructionsSimilar(a, b)).toBe(true);
      });
    });

    // These pairs have different meaningful words
    const differentPairs = [
      ["Get prices", "Get reviews"],
      ["Click submit", "Click cancel"],
      ["Extract title", "Extract description"],
      ["Find login form", "Find registration form"],
      ["Get product name", "Get product image"],
      // Different verbs won't match (semantic meaning is different)
      ["Get the page title", "Extract page title"],
      ["Click submit form", "Click the submit form button"],
    ];

    differentPairs.forEach(([a, b]) => {
      it(`"${a}" should NOT match "${b}"`, () => {
        expect(areInstructionsSimilar(a, b)).toBe(false);
      });
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      expect(normalizeInstruction("")).toBe("");
    });

    it("handles string with only stop words", () => {
      expect(normalizeInstruction("the a an")).toBe("");
    });

    it("handles single word", () => {
      expect(normalizeInstruction("prices")).toBe("price");
    });

    it("handles special characters", () => {
      expect(normalizeInstruction("Get $99.99 prices")).toBe("99 price");
    });

    it("handles numbers", () => {
      expect(normalizeInstruction("Get top 10 items")).toBe("10 item top");
    });
  });
});
