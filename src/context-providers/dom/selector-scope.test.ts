import { A11yDOMState, EncodedId } from "@/context-providers/a11y-dom/types";
import {
  detectSelectorType,
  scopeDomWithSelector,
  SelectorType,
} from "@/context-providers/dom/selector-scope";

const createHandle = (xpath: string) => ({
  evaluate: jest.fn(async () => xpath),
  dispose: jest.fn(async () => {}),
});

const createPageStub = (
  handles: Array<{ evaluate: () => Promise<string>; dispose: () => Promise<void> }>,
  frameCount = 1
) =>
  ({
    mainFrame: () => ({
      $$: jest.fn(async () => handles),
    }),
    frames: () => new Array(frameCount).fill({}),
  } as any);

const buildDomState = (): A11yDOMState => {
  const leaf = {
    role: "StaticText",
    name: "Leaf",
    children: [],
    encodedId: "0-3" as EncodedId,
  };
  const child = {
    role: "Group",
    name: "Child",
    children: [leaf],
    encodedId: "0-2" as EncodedId,
  };
  const root = {
    role: "RootWebArea",
    name: "Root",
    children: [child],
    encodedId: "0-1" as EncodedId,
  };

  return {
    domState: "FULL TREE",
    elements: new Map<EncodedId, any>([
      ["0-1" as EncodedId, root],
      ["0-2" as EncodedId, child],
      ["0-3" as EncodedId, leaf],
    ]),
    xpathMap: {
      "0-1": "//html[1]/body[1]/div[1]",
      "0-2": "//html[1]/body[1]/div[1]/section[1]",
      "0-3": "//html[1]/body[1]/div[1]/section[1]/span[1]",
    },
    backendNodeMap: {},
    frameMap: new Map([
      [
        0,
        {
          frameIndex: 0,
          xpath: "//html[1]/body[1]",
          parentFrameIndex: null,
          siblingPosition: 0,
          framePath: ["Main"],
        } as any,
      ],
    ]),
    frameDebugInfo: [
      {
        frameIndex: 0,
        frameUrl: "https://example.com",
        totalNodes: 3,
        treeElementCount: 3,
        interactiveCount: 0,
      },
    ],
  };
};

describe("selector scoping", () => {
  it("detects selector types automatically", () => {
    expect(detectSelectorType("//div")).toBe<SelectorType>("xpath");
    expect(detectSelectorType(".//div")).toBe<SelectorType>("xpath");
    expect(detectSelectorType("(//div)[1]")).toBe<SelectorType>("xpath");
    expect(detectSelectorType(".item")).toBe<SelectorType>("css");
    expect(detectSelectorType("div button")).toBe<SelectorType>("css");
  });

  it("scopes DOM to matching selector subtree", async () => {
    const domState = buildDomState();
    const page = createPageStub([
      createHandle("//html[1]/body[1]/div[1]/section[1]/span[1]"),
    ]);

    const result = await scopeDomWithSelector(
      page,
      domState,
      "//html[1]/body[1]/div[1]/section[1]/span[1]",
      "xpath"
    );

    expect(result.matched).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(result.domState.elements.size).toBe(1);
    expect(result.domState.domState).toContain("[0-3]");
    expect(result.domState.domState).not.toContain("[0-1]");
  });

  it("returns warning when selector does not resolve in multi-frame pages", async () => {
    const domState = buildDomState();
    const page = createPageStub([], 2);

    const result = await scopeDomWithSelector(page, domState, ".missing", "css");

    expect(result.matched).toBe(false);
    expect(result.warning).toContain("not yet supported");
    expect(result.domState).toBe(domState);
  });
});
