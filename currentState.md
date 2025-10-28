# HyperAgent Current State Analysis

## Overview
HyperAgent is a browser automation SDK that uses LLM-powered agents to execute tasks on web pages. It provides both imperative page methods (`page.ai()`, `page.extract()`) and a programmatic task execution API.

---

## Core Architecture

### 1. Entry Points & Public API

#### **HyperAgent Class** ([src/agent/index.ts](src/agent/index.ts))

The main class that orchestrates everything:

```typescript
class HyperAgent<T extends BrowserProviders = "Local"> {
  // Core methods
  async executeTask(task: string, params?: TaskParams, initPage?: Page): Promise<TaskOutput>
  async executeTaskAsync(task: string, params?: TaskParams, initPage?: Page): Promise<Task>

  // Page management
  async getCurrentPage(): Promise<Page>
  async newPage(): Promise<HyperPage>
  async getPages(): Promise<HyperPage[]>

  // Browser lifecycle
  async initBrowser(): Promise<Browser>
  async closeAgent(): Promise<void>
}
```

#### **HyperPage Interface** ([src/agent/index.ts:567-605](src/agent/index.ts#L567-L605))

Enhanced Playwright `Page` with AI methods:

```typescript
interface HyperPage extends Page {
  // Execute a task on this page
  ai(task: string, params?: TaskParams): Promise<TaskOutput>

  // Execute task asynchronously (non-blocking)
  aiAsync(task: string, params?: TaskParams): Promise<Task>

  // Extract structured data
  extract<T>(
    task?: string,
    outputSchema?: z.AnyZodObject,
    params?: TaskParams
  ): Promise<T | string>
}
```

**Key Implementation Details:**
- `page.ai()` → calls `agent.executeTask(task, params, page)` ([line 569-570](src/agent/index.ts#L569-L570))
- `page.extract()` → wraps `executeTask()` with extraction-specific prompts ([lines 573-603](src/agent/index.ts#L573-L603))
  - Adds `maxSteps: 2` by default for extractions
  - Prepends extraction instructions to the task
  - Parses JSON output if outputSchema provided

---

## 2. Task Execution Flow

### **Main Task Loop** ([src/agent/tools/agent.ts:105-306](src/agent/tools/agent.ts#L105-L306))

```
runAgentTask()
  ├── 1. Get DOM State (getDom)
  │   ├── Inject JavaScript into page
  │   ├── Find interactive elements
  │   ├── Draw numbered overlay (canvas)
  │   └── Capture screenshot with overlay
  │
  ├── 2. Build Agent Messages (buildAgentStepMessages)
  │   ├── System prompt
  │   ├── Task description
  │   ├── Previous steps context
  │   ├── DOM representation (text)
  │   └── Screenshot (base64 image)
  │
  ├── 3. Invoke LLM (llm.invokeStructured)
  │   ├── Request structured output (Zod schema)
  │   └── Get list of actions to execute
  │
  ├── 4. Execute Actions (runAction)
  │   ├── For each action in list
  │   ├── Run action handler
  │   └── Wait 2 seconds between actions
  │
  └── 5. Repeat until complete/cancelled/maxSteps
```

**Location:** [src/agent/tools/agent.ts:132-291](src/agent/tools/agent.ts#L132-L291)

---

## 3. DOM State Extraction

### **Current Implementation: Visual DOM with Canvas Overlay**

#### **Entry Point:** `getDom(page)` ([src/context-providers/dom/index.ts:5-18](src/context-providers/dom/index.ts#L5-L18))

```typescript
export const getDom = async (page: Page): Promise<DOMState | null> => {
  const result = await page.evaluate(buildDomViewJs) as DOMStateRaw;
  return {
    elements: Map<number, InteractiveElement>,
    domState: string,  // Text representation
    screenshot: string // Base64 PNG with overlays
  };
};
```

#### **Build DOM View** ([src/context-providers/dom/build-dom-view.ts:54-130](src/context-providers/dom/build-dom-view.ts#L54-L130))

**Process:**
1. **Find Interactive Elements** ([find-interactive-elements.ts:4-63](src/context-providers/dom/find-interactive-elements.ts#L4-L63))
   - Traverse entire DOM including Shadow DOM and iframes
   - Check each element with `isInteractiveElem(element)`
   - Returns `InteractiveElement[]` with metadata

2. **Render Highlights Offscreen** ([highlight.ts:105-222](src/context-providers/dom/highlight.ts#L105-L222))
   - Create `OffscreenCanvas` with viewport dimensions
   - Draw colored rectangles around each interactive element
   - Draw numbered labels (1, 2, 3...) on each element
   - Return `ImageBitmap`

3. **Composite Screenshot** ([agent.ts:33-42](src/agent/tools/agent.ts#L33-L42))
   ```typescript
   const compositeScreenshot = async (page: Page, overlay: string) => {
     const screenshot = await page.screenshot({ type: "png" });
     // Overlay numbered boxes onto base screenshot using Jimp
     baseImage.composite(overlayImage, 0, 0);
     return buffer.toString("base64");
   };
   ```

4. **Build Text Representation** ([build-dom-view.ts:78-123](src/context-providers/dom/build-dom-view.ts#L78-L123))
   ```
   [1]<button id="submit" class="btn-primary">Submit Form</button>
   [2]<input type="text" name="email" placeholder="Enter email">
   Some text between elements
   [3]<a href="/pricing">View Pricing</a>
   ```

**Output Structure:**
```typescript
interface DOMState {
  elements: Map<number, InteractiveElement>  // index → element mapping
  domState: string                          // [idx]<tag>text</tag> format
  screenshot: string                        // base64 PNG with overlays
}
```

---

## 4. Action System

### **Available Actions** ([src/agent/actions/](src/agent/actions/))

| Action | Purpose | Key Parameters | Location |
|--------|---------|----------------|----------|
| `clickElement` | Click an element | `index: number` | [click-element.ts](src/agent/actions/click-element.ts) |
| `inputText` | Fill input field | `index: number, text: string` | [input-text.ts](src/agent/actions/input-text.ts) |
| `extract` | Extract data | `objective: string` | [extract.ts](src/agent/actions/extract.ts) |
| `goToUrl` | Navigate to URL | `url: string` | [go-to-url.ts](src/agent/actions/go-to-url.ts) |
| `selectOption` | Select dropdown | `index: number, option: string` | [select-option.ts](src/agent/actions/select-option.ts) |
| `scroll` | Scroll page | `direction: "up"\|"down"` | [scroll.ts](src/agent/actions/scroll.ts) |
| `keyPress` | Press keyboard key | `key: string` | [key-press.ts](src/agent/actions/key-press.ts) |
| `complete` | End task | `output?: string` | [complete.ts](src/agent/actions/complete.ts) |

### **Action Execution** ([src/agent/tools/agent.ts:71-103](src/agent/tools/agent.ts#L71-L103))

#### **Click Element Example** ([click-element.ts:18-57](src/agent/actions/click-element.ts#L18-L57))

```typescript
run: async function (ctx: ActionContext, action: ClickElementActionType) {
  const { index } = action;
  const locator = getLocator(ctx, index);  // Get element by index

  await locator.scrollIntoViewIfNeeded({ timeout: 2500 });
  await locator.waitFor({ state: "visible", timeout: 2500 });
  await waitForElementToBeEnabled(locator, 2500);
  await waitForElementToBeStable(locator, 2500);

  await locator.click({ force: true });
  return { success: true, message: `Clicked element with index ${index}` };
}
```

**Element Selection:** ([actions/utils.ts](src/agent/actions/utils.ts))
```typescript
export const getLocator = (ctx: ActionContext, index: number): Locator | null => {
  const element = ctx.domState.elements.get(index);
  if (!element) return null;
  return ctx.page.locator(element.cssPath);  // Use CSS path selector
};
```

---

## 5. Key Workflows

### **Workflow 1: `page.ai("click the login button")`**

1. User calls `page.ai("click the login button")`
2. → `agent.executeTask(task, params, page)` ([index.ts:569](src/agent/index.ts#L569))
3. → `runAgentTask()` starts task loop ([agent.ts:105](src/agent/tools/agent.ts#L105))
4. → `getDom(page)` extracts DOM + screenshot ([agent.ts:155](src/agent/tools/agent.ts#L155))
   - Injects JS to find interactive elements
   - Draws numbered overlays
   - Composites screenshot
5. → `buildAgentStepMessages()` creates LLM prompt ([agent.ts:201](src/agent/tools/agent.ts#L201))
6. → `llm.invokeStructured()` gets action plan ([agent.ts:220](src/agent/tools/agent.ts#L220))
7. → Execute actions ([agent.ts:253-275](src/agent/tools/agent.ts#L253-L275))
   - LLM returns: `{ type: "clickElement", params: { index: 5 } }`
   - `runAction()` calls `ClickElementActionDefinition.run()`
   - Gets locator for element 5
   - Clicks element via Playwright
8. → Repeat loop or mark complete

### **Workflow 2: `page.extract("product prices", schema)`**

1. User calls `page.extract("product prices", PriceSchema)`
2. → Wraps task: "You have to perform an extraction on the current page..." ([index.ts:586-590](src/agent/index.ts#L586-L590))
3. → Sets `maxSteps: 2` (extractions are quick) ([index.ts:581](src/agent/index.ts#L581))
4. → Adds `outputSchema` to actions ([index.ts:584](src/agent/index.ts#L584))
5. → `executeTask()` runs normal agent loop
6. → LLM returns structured output matching schema
7. → Parse JSON and return typed result ([index.ts:592](src/agent/index.ts#L592))

### **Workflow 3: Extract Action (Internal)**

The `extract` action is **different** from `page.extract()`:

**Location:** [src/agent/actions/extract.ts](src/agent/actions/extract.ts)

```typescript
run: async (ctx: ActionContext, action: ExtractActionType) => {
  // Get page HTML
  const content = await ctx.page.content();
  const markdown = await parseMarkdown(content);

  // Take screenshot via CDP
  const cdpSession = await ctx.page.context().newCDPSession(ctx.page);
  const screenshot = await cdpSession.send("Page.captureScreenshot");

  // Call LLM with markdown + screenshot
  const response = await ctx.llm.invoke([{
    role: "user",
    content: [
      { type: "text", text: `Extract: "${objective}"\n\n${markdown}` },
      { type: "image", url: `data:image/png;base64,${screenshot.data}` }
    ]
  }]);

  return { success: true, message: `Extracted: ${content}` };
}
```

**This is an action the agent can choose** during task execution, not the page-level method.

---

## 6. DOM State Representation

### **Current Approach: Visual DOM + Numbered Overlay**

**Strengths:**
- ✅ Simple index-based selection (LLM just says "5")
- ✅ Visual feedback in screenshots
- ✅ Works well with vision models

**Weaknesses:**
- ❌ Screenshot required every step (slow)
- ❌ Screenshot → LLM → token cost is high
- ❌ Numbered overlay can occlude important UI
- ❌ Full DOM traversal every step (no caching)
- ❌ Large token counts (screenshot + DOM text)

**Performance:**
- ~8,000-15,000 tokens per step
- ~1,500-3,000ms per action
- No caching mechanism

---

## 7. Element Discovery

### **Interactive Element Detection** ([src/context-providers/dom/elem-interactive.ts](src/context-providers/dom/elem-interactive.ts))

**Current Rules:**
```typescript
isInteractiveElem(element: HTMLElement): { isInteractive: boolean, reason?: string }
```

**Checks (in order):**
1. Native interactive tags: `button`, `a[href]`, `input`, `select`, `textarea`
2. ARIA roles: `button`, `link`, `tab`, `checkbox`, `menuitem`
3. Event listeners: `data-has-interactive-listener="true"` (injected)
4. Contenteditable elements
5. Elements with `onclick` attribute
6. Cursor style: `cursor: pointer`
7. Custom detection for common patterns

**Ignored Elements:**
- Hidden elements (`display: none`, `visibility: hidden`)
- Zero-dimension elements
- Disabled elements
- Script and style tags

---

## 8. Message Building

### **Prompt Construction** ([src/agent/messages/builder.ts](src/agent/messages/builder.ts))

**Message Structure:**
```typescript
[
  { role: "system", content: SYSTEM_PROMPT },
  { role: "user", content: [
    { type: "text", text: "Task: click login button\n\nDOMState:\n[1]<button>..." },
    { type: "image", url: "data:image/png;base64,..." }
  ]},
  { role: "assistant", content: "..." },  // Previous step
  { role: "user", content: "..." },       // Previous action results
  // ... more history ...
  { role: "user", content: [             // Current step
    { type: "text", text: "Current DOM:\n..." },
    { type: "image", url: "..." }
  ]}
]
```

---

## 9. Variable System

### **Variable Management** ([src/agent/index.ts:174-202](src/agent/index.ts#L174-L202))

```typescript
interface HyperVariable {
  key: string;
  value: string;
  description?: string;
}

// API
agent.addVariable({ key: "email", value: "user@example.com" })
agent.getVariable("email")
agent.deleteVariable("email")
```

**Usage in Actions:**
```typescript
// In inputText action:
text = text.replace(`<<${variable.key}>>`, variable.value);
// Agent can use: inputText(5, "<<email>>") → "user@example.com"
```

---

## 10. Browser Provider Architecture

### **Supported Providers:**

1. **LocalBrowserProvider** (default)
   - Uses `patchright` (Playwright fork with anti-detection)
   - Runs locally

2. **HyperbrowserProvider**
   - Cloud-based browser service
   - Remote CDP connection

**Selection:** ([index.ts:85-94](src/agent/index.ts#L85-L94))
```typescript
new HyperAgent({
  browserProvider: "Local" | "Hyperbrowser",
  localConfig: { ... },
  hyperbrowserConfig: { ... }
})
```

---

## 11. MCP Integration

### **Model Context Protocol Support** ([src/agent/mcp/](src/agent/mcp/))

**Purpose:** Connect external tools as custom actions

```typescript
await agent.initializeMCPClient({
  servers: [{
    id: "filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"]
  }]
});
```

**How it works:**
1. MCP server exposes tools
2. Tools converted to `AgentActionDefinition`
3. Registered with agent
4. LLM can invoke MCP tools as actions

---

## 12. Debug Mode

### **Debug Output** ([src/agent/tools/agent.ts:112-148](src/agent/tools/agent.ts#L112-L148))

When `debug: true`:

```
debug/
  └── {taskId}/
      ├── step-0/
      │   ├── elems.txt              # DOM text representation
      │   ├── screenshot.png         # Composite screenshot
      │   ├── msgs.json              # LLM messages
      │   └── stepOutput.json        # Action results
      ├── step-1/
      └── taskOutput.json            # Final output
```

---

## 13. Summary: Current vs Desired State

### **What Works Well:**
- ✅ Simple API (`page.ai()`, `page.extract()`)
- ✅ Flexible action system
- ✅ Multi-step task execution
- ✅ MCP integration
- ✅ Variable substitution

### **Performance Bottlenecks:**
- ❌ Screenshot required every step
- ❌ No DOM caching
- ❌ No action caching
- ❌ High token usage (8K-15K per step)
- ❌ Slow actions (1.5-3s each)

### **Accuracy Issues:**
- ❌ Numbered overlay can be occluded
- ❌ Full DOM may miss semantic meaning
- ❌ No accessibility tree
- ❌ No self-healing on failure
- ❌ Single-attempt actions (no retry logic)

---

## 14. File Reference Map

| Component | File Path | Key Lines |
|-----------|-----------|-----------|
| **Main Agent Class** | `src/agent/index.ts` | 37-606 |
| **Task Execution Loop** | `src/agent/tools/agent.ts` | 105-306 |
| **DOM Extraction** | `src/context-providers/dom/index.ts` | 5-18 |
| **Build DOM View** | `src/context-providers/dom/build-dom-view.ts` | 54-130 |
| **Find Elements** | `src/context-providers/dom/find-interactive-elements.ts` | 4-63 |
| **Canvas Overlay** | `src/context-providers/dom/highlight.ts` | 105-222 |
| **Click Action** | `src/agent/actions/click-element.ts` | 18-57 |
| **Input Text Action** | `src/agent/actions/input-text.ts` | 16-37 |
| **Extract Action** | `src/agent/actions/extract.ts` | 16-104 |
| **System Prompt** | `src/agent/messages/system-prompt.ts` | - |
| **Message Builder** | `src/agent/messages/builder.ts` | - |

---

## Next Steps: Performance & Accuracy Improvements

Based on Stagehand and Skyvern analysis, key opportunities:

1. **Adopt Accessibility Tree** (Stagehand approach)
   - 3-4x token reduction
   - Better semantic understanding
   - No screenshot required for actions

2. **Implement Caching** (Stagehand approach)
   - Action cache (instruction+URL → selector)
   - LLM cache (prompt → response)
   - 20-30x speed improvement for cached actions

3. **Hybrid Visual Approach** (Skyvern approach)
   - DOM injection for element IDs (no overlay)
   - Bounding boxes only when needed
   - Keep visual feedback but reduce occlusion

4. **Self-Healing** (Stagehand approach)
   - Re-observe on failure
   - Multiple selector strategies
   - Retry logic with different approaches

See `improvement-plan.md` for detailed implementation strategy.
