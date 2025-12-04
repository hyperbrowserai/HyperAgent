import {
  extractStructure,
  extractContent,
} from "./structural-hash";

describe("Structural DOM Hashing", () => {
  describe("extractStructure", () => {
    it("extracts structure without text content", () => {
      const domState = `=== Frame 0 (Main) ===
[0-123] button: Click me
  [0-124] StaticText: Click me
[0-125] heading: Welcome to our site
[0-126] link: Learn more`;

      const structure = extractStructure(domState);

      expect(structure).toBe(`=== Frame 0 (Main) ===
[0-123] button
  [0-124] StaticText
[0-125] heading
[0-126] link`);
    });

    it("preserves frame headers", () => {
      const domState = `=== Frame 0 (Main) ===
[0-1] button: Submit
=== Frame 1 (iframe → nested) ===
[1-1] link: Click`;

      const structure = extractStructure(domState);

      expect(structure).toContain("=== Frame 0 (Main) ===");
      expect(structure).toContain("=== Frame 1 (iframe → nested) ===");
    });

    it("produces same structure for pages with different text content", () => {
      const page1 = `=== Frame 0 (Main) ===
[0-1] heading: Updated 2 minutes ago
[0-2] button: Refresh`;

      const page2 = `=== Frame 0 (Main) ===
[0-1] heading: Updated 5 hours ago
[0-2] button: Refresh`;

      const structure1 = extractStructure(page1);
      const structure2 = extractStructure(page2);

      expect(structure1).toBe(structure2);
    });

    it("produces different structure when elements are added", () => {
      const page1 = `=== Frame 0 (Main) ===
[0-1] heading: Title
[0-2] button: Submit`;

      const page2 = `=== Frame 0 (Main) ===
[0-1] heading: Title
[0-3] paragraph: New paragraph
[0-2] button: Submit`;

      const structure1 = extractStructure(page1);
      const structure2 = extractStructure(page2);

      expect(structure1).not.toBe(structure2);
    });

    it("preserves indentation hierarchy", () => {
      const domState = `=== Frame 0 (Main) ===
[0-1] div
  [0-2] span: nested
    [0-3] link: deep`;

      const structure = extractStructure(domState);

      expect(structure).toBe(`=== Frame 0 (Main) ===
[0-1] div
  [0-2] span
    [0-3] link`);
    });

    it("handles roles without names", () => {
      const domState = `=== Frame 0 (Main) ===
[0-1] div
[0-2] button: Click`;

      const structure = extractStructure(domState);

      expect(structure).toBe(`=== Frame 0 (Main) ===
[0-1] div
[0-2] button`);
    });
  });

  describe("extractContent", () => {
    it("extracts only text content", () => {
      const domState = `=== Frame 0 (Main) ===
[0-123] button: Click me
[0-125] heading: Welcome`;

      const content = extractContent(domState);

      expect(content).toBe("Click me|Welcome");
    });

    it("skips elements without names", () => {
      const domState = `=== Frame 0 (Main) ===
[0-1] div
[0-2] button: Submit
[0-3] span`;

      const content = extractContent(domState);

      expect(content).toBe("Submit");
    });

    it("ignores frame headers", () => {
      const domState = `=== Frame 0 (Main) ===
[0-1] button: Click`;

      const content = extractContent(domState);

      expect(content).not.toContain("Frame");
      expect(content).toBe("Click");
    });
  });

  describe("cache hit scenarios", () => {
    it("timestamp changes should produce same structure", () => {
      const timeVariants = [
        "Last updated: 2 minutes ago",
        "Last updated: 3 minutes ago",
        "Last updated: 1 hour ago",
        "Last updated: just now",
      ];

      const structures = timeVariants.map((text) => {
        const dom = `=== Frame 0 (Main) ===
[0-1] heading: ${text}
[0-2] button: Refresh`;
        return extractStructure(dom);
      });

      // All structures should be identical
      const unique = new Set(structures);
      expect(unique.size).toBe(1);
    });

    it("counter changes should produce same structure", () => {
      const counterVariants = ["5 items", "10 items", "0 items", "1 item"];

      const structures = counterVariants.map((text) => {
        const dom = `=== Frame 0 (Main) ===
[0-1] StaticText: ${text}
[0-2] link: View all`;
        return extractStructure(dom);
      });

      const unique = new Set(structures);
      expect(unique.size).toBe(1);
    });
  });

  describe("cache miss scenarios", () => {
    it("new element should produce different structure", () => {
      const before = `=== Frame 0 (Main) ===
[0-1] button: Submit`;

      const after = `=== Frame 0 (Main) ===
[0-1] button: Submit
[0-2] link: Cancel`;

      expect(extractStructure(before)).not.toBe(extractStructure(after));
    });

    it("removed element should produce different structure", () => {
      const before = `=== Frame 0 (Main) ===
[0-1] button: Submit
[0-2] link: Cancel`;

      const after = `=== Frame 0 (Main) ===
[0-1] button: Submit`;

      expect(extractStructure(before)).not.toBe(extractStructure(after));
    });

    it("changed role should produce different structure", () => {
      const before = `=== Frame 0 (Main) ===
[0-1] button: Click`;

      const after = `=== Frame 0 (Main) ===
[0-1] link: Click`;

      expect(extractStructure(before)).not.toBe(extractStructure(after));
    });
  });
});
