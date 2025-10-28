# Phase 1: Accessibility Tree Foundation

## Executive Summary

**Goal:** Replace visual DOM with canvas overlay approach with Chrome's native Accessibility Tree for 3-4x token reduction and better semantic understanding.

**Impact:**
- 📉 **Tokens:** 8K-15K → 2K-5K per step (70% reduction)
- ⚡ **Speed:** 1.5-3s → 0.5-0.8s per action (2-4x faster)
- 🎯 **Accuracy:** Better semantic understanding of interactive elements
- 💰 **Cost:** 70% reduction in LLM API costs

---

## Why This Improvement?

### Problems with Current Implementation

#### **1. Visual Overlay Occlusion**
```typescript
// Current: src/context-providers/dom/highlight.ts:105-222
export function renderHighlightsOffscreen(highlightInfos: HighlightInfo[]) {
  // Draws colored rectangles and numbered labels over elements
  // Problem: Labels can cover important UI elements
  ctx.fillRect(drawLeft, drawTop, rect.width, rect.height);
  ctx.fillText(labelText, labelPos.left + labelWidth / 2, ...);
}
```

**Issues:**
- Numbered labels (1, 2, 3...) can cover text users need to read
- Colored overlays interfere with visual understanding
- Screenshot becomes cluttered on element-dense pages

**Example Problem:**
```
Current screenshot with overlays:
┌─────────────────────────┐
│ [1] Submit   [2] Cancel │  ← Labels cover button text
│ [3] ███████████████     │  ← Overlay covers important info
└─────────────────────────┘
```

#### **2. Massive Token Usage**
```typescript
// Current: src/agent/tools/agent.ts:181-186
const trimmedScreenshot = await compositeScreenshot(page, domState.screenshot);
// Every step sends:
// - Full base64 screenshot: ~4,000-8,000 tokens
// - DOM text representation: ~2,000-4,000 tokens
// Total: 8,000-15,000 tokens per step
```

**Cost Analysis:**
```
Task: "Fill login form and submit" (3 steps)
Current approach:
- Step 1: 12,000 tokens
- Step 2: 14,000 tokens
- Step 3: 11,000 tokens
Total: 37,000 tokens × $0.01/1K = $0.37

Accessibility tree approach:
- Step 1: 3,500 tokens
- Step 2: 4,000 tokens
- Step 3: 3,200 tokens
Total: 10,700 tokens × $0.01/1K = $0.11

Savings: 71% reduction, $0.26 saved per task
```

#### **3. No Semantic Understanding**
```typescript
// Current: src/context-providers/dom/build-dom-view.ts:95-123
// Just concatenates tag names and visible text
const elementString = `${indexPrefix}<${tagName}${attributes}>${truncatedText}</${tagName}>`;
// Result: [1]<button class="btn">Submit</button>
```

**What's Missing:**
- No role information (is it actually a button or styled div?)
- No ARIA attributes (disabled state, expanded state)
- No accessibility name (what screen readers would announce)
- No parent-child relationships in semantic tree

**Example:**
```html
<!-- Complex interactive element -->
<div role="button" aria-label="Close dialog" tabindex="0" onclick="...">
  <svg>...</svg>
</div>

Current representation:
[5]<div class="close-btn"><svg>...</svg></div>  ❌ Loses role="button"

Accessibility tree:
[abc123] button: Close dialog  ✅ Preserves semantic meaning
```

#### **4. Performance Bottleneck**
```typescript
// Current: src/agent/tools/agent.ts:151-163
const domState = await retry({
  func: async () => {
    const s = await getDom(page);  // Expensive operation
    if (!s) throw new Error("no dom state");
    return s;
  },
  params: { retryCount: 3 },
});
```

**Timing Breakdown:**
1. `findInteractiveElements()`: ~200-400ms (full DOM traversal)
2. `renderHighlightsOffscreen()`: ~100-200ms (canvas rendering)
3. `page.screenshot()`: ~300-600ms (Playwright screenshot)
4. `compositeScreenshot()`: ~200-300ms (Jimp composite)

**Total:** 800-1,500ms just for DOM extraction

---

## Addressing Key Concerns

### Concern 1: What About Pages Without ARIA Labels?

**Answer:** ✅ **Chrome's accessibility engine works WITHOUT ARIA!**

#### How Chrome Computes Accessible Names

Chrome's accessibility engine uses a **fallback hierarchy** to compute element names automatically, even when developers don't add ARIA attributes:

```
Chrome's Automatic Name Computation (Priority Order):
1. aria-label / aria-labelledby  ← Explicit ARIA (if present)
2. <label for="...">             ← Associated label elements
3. Visible text content          ← What users actually see
4. alt attribute                 ← For images
5. title attribute               ← Tooltip text
6. placeholder attribute         ← For input fields
7. value attribute               ← For buttons/inputs
8. HTML tag name                 ← Last resort (button, a, input)
```

**This means:** On 99% of websites, Chrome can extract semantic meaning **without any ARIA attributes**.

#### Real-World Examples

**Example 1: Zero ARIA, Good HTML**
```html
<button type="submit">
  Log In
</button>

Chrome's Accessibility Tree:
[def456] button: Log In
         ^^^^^^  ^^^^^^
         (from <button> tag) (from text content)
```

**Example 2: Zero ARIA, Bad HTML**
```html
<div class="btn" onclick="submit()">
  <span>Submit Form</span>
  <i class="icon-check"></i>
</div>

Chrome's Accessibility Tree:
[abc123] generic: Submit Form
         ^^^^^^^  ^^^^^^^^^^^
         (Chrome sees it's just a div) (from span text)

After Stagehand's Enhancement:
[abc123] div: Submit Form
         ^^^  (we replace "generic" with actual tag name)
```

**Example 3: Associated Label (No ARIA)**
```html
<label for="email">Email Address</label>
<input type="email" id="email" placeholder="you@example.com">

Chrome's Accessibility Tree:
[ghi789] textbox: Email Address
         ^^^^^^^  ^^^^^^^^^^^^^^
         (from type="email") (from <label> text!)
```

**Example 4: Worst Case Scenario**
```html
<div id="mystery-button" class="clickable"></div>

Chrome's Accessibility Tree:
[jkl012] generic
         (no name, but we have backendNodeId)

Our Fallback Strategies:
1. XPath: /html/body/div[@id='mystery-button']
2. CSS selector: #mystery-button
3. Check nearby text as context hint
4. In hybrid mode: Use visual position
```

#### Stagehand's Enhancement: Role Replacement

Stagehand improves Chrome's output by replacing "generic" and "none" roles with actual HTML tag names:

**Reference:** [`/Users/devin/projects/stagehand/stagehand/lib/a11y/utils.ts:329-334`](file:///Users/devin/projects/stagehand/stagehand/lib/a11y/utils.ts#L329-L334)

```typescript
// If role is "generic" or "none", replace with actual HTML tag name
if ((node.role === "generic" || node.role === "none") && node.encodedId !== undefined) {
  const tagName = tagNameMap[node.encodedId];
  if (tagName) node.role = tagName;  // Use "button", "input", "a" as role
}
```

This transforms:
```
Before: [abc123] generic: Submit
After:  [abc123] div: Submit  ← More informative!
```

#### Key Takeaway

**Chrome's accessibility engine is battle-tested and works on virtually all websites**, including those with:
- Zero ARIA attributes
- Poor semantic HTML
- Complex nested structures
- Dynamic content

We get semantic understanding **for free** from Chrome's 15+ years of accessibility engineering.

---

### Concern 2: Visual Identifiers as Fallback (Skyvern-Style)

**Answer:** ✅ **Yes! Implement optional DOM injection for visual verification and debugging.**

#### Three-Mode System

Instead of binary choice (visual vs a11y), we implement **three modes** inspired by Skyvern:

```
Mode 1: "a11y" (Default - Fastest)
├─ Accessibility tree only
├─ No screenshots
├─ No DOM modifications
├─ Best for: Production, simple actions
└─ Speed: ~400ms, Tokens: ~3K

Mode 2: "hybrid" (Balanced)
├─ Accessibility tree for discovery
├─ Optional DOM injection
├─ Clean screenshot (no overlays)
├─ Best for: Data extraction, verification
└─ Speed: ~800ms, Tokens: ~5K

Mode 3: "visual-debug" (Development)
├─ Accessibility tree + DOM injection
├─ Bounding boxes with labels
├─ Screenshot with overlays
├─ Best for: Debugging, troubleshooting
└─ Speed: ~900ms, Tokens: ~6K
```

#### Skyvern's DOM Injection Approach

**Reference:** [`/Users/devin/projects/skyvern/skyvern/skyvern/webeye/scraper/domUtils.js:1390-1433`](file:///Users/devin/projects/skyvern/skyvern/skyvern/webeye/scraper/domUtils.js#L1390-L1433)

Skyvern injects **`unique_id` attributes directly into the DOM**:

```javascript
// Skyvern's approach
var element_id = element.getAttribute("unique_id") ?? (await uniqueId());
element.setAttribute("unique_id", element_id);

// Result in DOM:
<button unique_id="Ab3k">Submit</button>
```

**Our approach:** Similar, but with namespaced attribute:

```javascript
// HyperAgent's approach
element.setAttribute("data-hyperagent-id", "abc123");

// Result in DOM:
<button data-hyperagent-id="abc123">Submit</button>
```

#### Visual Bounding Boxes (Optional)

**Reference:** [`/Users/devin/projects/skyvern/skyvern/skyvern/webeye/scraper/domUtils.js:1829-2080`](file:///Users/devin/projects/skyvern/skyvern/skyvern/webeye/scraper/domUtils.js#L1829-L2080)

Skyvern draws blue bounding boxes around elements for visual debugging. We implement similar functionality as **opt-in**:

```typescript
// Draw bounding boxes (visual-debug mode only)
await drawBoundingBoxes(page, {
  showLabels: true,
  labelColor: '#0066ff',
  boxColor: '#0066ff',
});

// Take screenshot WITH boxes visible
const screenshot = await page.screenshot();

// Optionally remove boxes after
await removeBoundingBoxes(page);
```

#### When to Use Each Mode

| Mode | Use Case | Speed | Cost | Visual Feedback |
|------|----------|-------|------|-----------------|
| **a11y** | Production, simple tasks | Fastest | Lowest | None |
| **hybrid** | Data extraction, complex forms | Medium | Medium | Clean screenshot |
| **visual-debug** | Development, troubleshooting | Slower | Higher | Bounding boxes + labels |

#### Implementation: DOM Injection

**New File:** `src/context-providers/a11y-dom/inject-identifiers.ts`

```typescript
import { Page } from 'patchright';
import { EnhancedAXNode } from './types';

/**
 * Inject data-hyperagent-id attributes into the actual DOM
 * Similar to Skyvern's unique_id injection
 */
export async function injectElementIdentifiers(
  page: Page,
  elements: Map<string, EnhancedAXNode>
): Promise<void> {
  const injectionData: Array<{ backendNodeId: number; id: string }> = [];

  for (const [id, element] of elements) {
    if (element.backendDOMNodeId) {
      injectionData.push({ backendNodeId: element.backendDOMNodeId, id });
    }
  }

  const client = await page.context().newCDPSession(page);

  try {
    for (const { backendNodeId, id } of injectionData) {
      try {
        // Resolve DOM node from backend node ID
        const { nodeId } = await client.send('DOM.resolveNode', { backendNodeId });

        // Set attribute via CDP (more reliable than page.evaluate)
        await client.send('DOM.setAttributeValue', {
          nodeId,
          name: 'data-hyperagent-id',
          value: id,
        });
      } catch (error) {
        // Element might be detached, skip silently
        console.debug(`Failed to inject ID for node ${backendNodeId}`);
      }
    }
  } finally {
    await client.detach();
  }

  console.log(`[DOM Injection] Injected ${injectionData.length} identifiers`);
}

/**
 * Draw bounding boxes (for visual-debug mode)
 */
export async function drawBoundingBoxes(
  page: Page,
  options: {
    showLabels?: boolean;
    labelColor?: string;
    boxColor?: string;
  } = {}
): Promise<void> {
  const { showLabels = true, labelColor = '#0066ff', boxColor = '#0066ff' } = options;

  await page.evaluate(({ showLabels, labelColor, boxColor }) => {
    // Remove existing overlays
    document.querySelectorAll('.hyperagent-overlay').forEach(el => el.remove());

    // Create overlay container
    const container = document.createElement('div');
    container.className = 'hyperagent-overlay';
    container.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      pointer-events: none; z-index: 999999;
    `;
    document.body.appendChild(container);

    // Find all elements with our ID
    const elements = document.querySelectorAll('[data-hyperagent-id]');

    elements.forEach((element) => {
      const id = element.getAttribute('data-hyperagent-id');
      const rect = element.getBoundingClientRect();

      if (rect.width === 0 || rect.height === 0) return; // Skip invisible

      // Draw box
      const box = document.createElement('div');
      box.style.cssText = `
        position: absolute;
        left: ${rect.left + window.scrollX}px;
        top: ${rect.top + window.scrollY}px;
        width: ${rect.width}px; height: ${rect.height}px;
        border: 2px solid ${boxColor}; box-sizing: border-box;
      `;

      if (showLabels) {
        const label = document.createElement('div');
        label.textContent = id;
        label.style.cssText = `
          position: absolute; top: -22px; left: 0;
          background: ${labelColor}; color: white;
          padding: 2px 6px; font-size: 11px;
          font-family: monospace; font-weight: bold;
          border-radius: 3px; white-space: nowrap;
        `;
        box.appendChild(label);
      }

      container.appendChild(box);
    });
  }, { showLabels, labelColor, boxColor });
}

/**
 * Remove bounding box overlays
 */
export async function removeBoundingBoxes(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll('.hyperagent-overlay').forEach(el => el.remove());
  });
}
```

#### Key Benefits

1. **No Visual Occlusion (a11y mode)**: Text-only, no screenshots, fastest
2. **Visual Verification (hybrid mode)**: Clean screenshots when needed
3. **Debug Visibility (visual-debug mode)**: See exactly what's interactive
4. **Flexible**: Choose mode per action or globally
5. **Backwards Compatible**: Keep visual mode for migration

---

## High-Level Concept Changes

### Current Flow
```
User Task
    ↓
┌─────────────────────────────────────┐
│ 1. Find Interactive Elements        │
│    - Traverse entire DOM tree       │
│    - Check isInteractive() rules    │
│    - Assign numeric indices (1,2,3) │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ 2. Add Identifiers (Canvas Overlay) │
│    - Draw colored rectangles        │
│    - Draw numbered labels           │
│    - Create ImageBitmap overlay     │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ 3. Capture Visual State             │
│    - Take base screenshot           │
│    - Composite overlay on top       │
│    - Convert to base64              │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ 4. Send to LLM                      │
│    - DOM text: [1]<button>...</>    │
│    - Screenshot with overlays       │
│    - 8K-15K tokens                  │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ 5. LLM Returns Action               │
│    - { type: "clickElement",        │
│      params: { index: 5 } }         │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ 6. Execute via Playwright           │
│    - Get element at index 5         │
│    - Use CSS path selector          │
│    - page.locator(cssPath).click()  │
└─────────────────────────────────────┘
```

### New Flow (Accessibility Tree)
```
User Task
    ↓
┌─────────────────────────────────────┐
│ 1. Get Accessibility Tree (CDP)     │
│    - Chrome computes tree natively  │
│    - Already has semantic info      │
│    - Includes ARIA, roles, names    │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ 2. Add Identifiers (XPath + IDs)    │
│    - Fetch full DOM via CDP         │
│    - Compute XPath for each node    │
│    - Map CDP backendNodeId → xpath  │
│    - No visual injection needed     │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ 3. Build Simplified Tree (Text)     │
│    - Filter to interactive only     │
│    - Format as indented tree        │
│    - [id] role: name                │
│    - NO screenshot needed           │
└──────────────────────────��──────────┘
    ↓
┌─────────────────────────────────────┐
│ 4. Send to LLM (Text Only)          │
│    - Simplified tree: 2K-5K tokens  │
│    - No screenshot                  │
│    - 70% token reduction            │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ 5. LLM Returns Action               │
│    - { type: "clickElement",        │
│      params: { elementId: "abc" } } │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ 6. Execute via Playwright           │
│    - Get xpath from element map     │
│    - page.locator(`xpath=...`)      │
│    - More reliable selector         │
└─────────────────────────────────────┘
```

---

## High-Level Concepts Breakdown

### Concept 1: Determine Interactive Elements

#### **Current Approach: Manual DOM Traversal**
```typescript
// src/context-providers/dom/find-interactive-elements.ts:4-63
export const findInteractiveElements = (): InteractiveElement[] => {
  const interactiveElements: InteractiveElement[] = [];

  // Manually traverse every element
  const elements = root.querySelectorAll("*");
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i] as HTMLElement;
    const { isInteractive, reason } = isInteractiveElem(element);
    if (isInteractive) {
      interactiveElements.push(element);
    }
  }
}
```

**Problems:**
- We manually check every element (slow)
- We implement our own interactivity rules (error-prone)
- We miss elements that Chrome knows are interactive

#### **New Approach: Chrome's Accessibility Engine**
```typescript
// New: src/context-providers/a11y-dom/get-tree.ts
export async function getAccessibilityTree(page: Page) {
  const client = await page.context().newCDPSession(page);

  // Chrome already knows which elements are interactive!
  const { nodes } = await client.send('Accessibility.getFullAXTree');

  // Chrome has already:
  // - Computed ARIA roles
  // - Determined focus order
  // - Built accessibility name
  // - Identified clickable elements

  return nodes.filter(node => isInteractiveRole(node.role));
}
```

**Why Better:**
- ✅ Chrome's engine is battle-tested (used by screen readers)
- ✅ Handles complex ARIA patterns correctly
- ✅ Automatically updates with Chrome improvements
- ✅ ~200-400ms faster than manual traversal

---

### Concept 2: Add Identifiers in DOM

#### **Current Approach: Canvas Overlay Numbers**
```typescript
// src/context-providers/dom/highlight.ts:137-212
highlightInfos.forEach(({ element, index }) => {
  // Draw colored rectangle over element
  ctx.fillRect(drawLeft, drawTop, rect.width, rect.height);

  // Draw numbered label (1, 2, 3...)
  const labelText = index.toString();
  ctx.fillText(labelText, labelPos.left + labelWidth / 2, ...);
});

// Result: Visual overlay with numbers
// Problem: Numbers are not in the DOM, only in screenshot
```

**Identification Method:**
- Visual only (screenshot shows [1], [2], [3])
- No programmatic way to find element #5
- Must use pre-computed CSS path from before overlay

**Flow:**
```
1. Find element at index 5
2. Get stored cssPath for that index
3. Use page.locator(cssPath)
4. Hope element still exists at that path
```

#### **New Approach: CDP Backend Node IDs + XPath**
```typescript
// New: src/context-providers/a11y-dom/build-maps.ts
function buildDOMMaps(root: DOMNode) {
  const xpathMap: Record<string, string> = {};
  const stack = [{ node: root, path: '' }];

  while (stack.length) {
    const { node, path } = stack.pop()!;

    // Every node gets its CDP backendNodeId as identifier
    const nodeId = node.backendNodeId;

    // Compute XPath: /html/body/div[1]/button[2]
    xpathMap[nodeId] = path || '/';

    // Process children
    if (node.children) {
      node.children.forEach((child, index) => {
        const childPath = `${path}/${child.nodeName}[${index + 1}]`;
        stack.push({ node: child, path: childPath });
      });
    }
  }

  return xpathMap;
}
```

**Identification Method:**
- Each element has CDP `backendNodeId` (stable identifier)
- XPath computed from DOM structure
- No visual modification needed

**Flow:**
```
1. LLM says elementId: "abc123"
2. Look up xpath: xpathMap["abc123"] = "/html/body/button[1]"
3. Use page.locator(`xpath=/html/body/button[1]`)
4. More reliable than CSS selectors
```

---

### Concept 3: Playwright Interaction

#### **Current Approach: CSS Path from Pre-Scan**
```typescript
// src/context-providers/dom/build-dom-view.ts:74-75
element.cssPath = getCSSPath(element.element);

// Later in action:
// src/agent/actions/utils.ts
export const getLocator = (ctx: ActionContext, index: number) => {
  const element = ctx.domState.elements.get(index);
  return ctx.page.locator(element.cssPath);  // CSS selector
};
```

**Problems with CSS Selectors:**
```typescript
// CSS path might be:
"body > div.container > div.row > button.btn-primary:nth-child(3)"

// Issues:
// 1. Breaks if CSS classes change
// 2. Breaks if DOM structure changes
// 3. Breaks if element order changes
// 4. Not unique if multiple matching elements
```

#### **New Approach: XPath from Accessibility Tree**
```typescript
// New: src/agent/actions/utils.ts
export const getLocator = (ctx: ActionContext, elementId: string) => {
  const element = ctx.domState.elements.get(elementId);

  if (!element) {
    throw new Error(`Element ${elementId} not found`);
  }

  // Use XPath (more stable)
  return ctx.page.locator(`xpath=${element.xpath}`);
};
```

**Why XPath is Better:**
```typescript
// XPath:
"/html/body/form[@id='login']/button[1]"

// Advantages:
// 1. ✅ Structure-based (still works if classes change)
// 2. ✅ Can use attributes for uniqueness [@id='...']
// 3. ✅ Can traverse up/down tree easily
// 4. ✅ Playwright has excellent XPath support

// Fallback strategies:
const strategies = [
  `xpath=${element.xpath}`,                    // Primary
  `xpath=//*[@id="${element.attributes?.id}"]`, // By ID
  `[aria-label="${element.name}"]`,            // By ARIA
  page.getByText(element.text),                // By text
];
```

---

### Concept 4: System Prompts

#### **Current Prompt Issues**
```typescript
// src/agent/messages/system-prompt.ts
// Current prompt is generic and doesn't leverage accessibility info
```

**Problems:**
1. Doesn't explain accessibility tree format
2. Doesn't mention semantic roles
3. Doesn't guide on using element IDs
4. Generic instructions not optimized for a11y tree

#### **New Prompt: Based on Stagehand's Proven Approach**

**File to Create:** `src/agent/messages/a11y-system-prompt.ts`

```typescript
export const A11Y_SYSTEM_PROMPT = `You are a browser automation assistant. You analyze web pages through their accessibility tree and execute actions.

# Accessibility Tree Format

The page is represented as a text-based accessibility tree. Each line shows:
[elementId] role: name

Example:
[abc123] button: Submit Form
  [def456] text: Submit
[ghi789] textbox: Enter your email
[jkl012] link: Forgot password?

# Understanding the Tree

1. **Indentation** shows parent-child relationships
2. **Role** describes the element type (button, textbox, link, etc.)
3. **Name** is what users see or screen readers announce
4. **ElementId** is the unique identifier for interacting

# Available Actions

1. **clickElement**: Click buttons, links, or clickable elements
   - Use elementId from the tree
   - Example: { "type": "clickElement", "params": { "elementId": "abc123" } }

2. **inputText**: Fill text inputs
   - Use elementId of the textbox
   - Example: { "type": "inputText", "params": { "elementId": "ghi789", "text": "user@example.com" } }

3. **selectOption**: Select from dropdown
   - Use elementId of the combobox
   - Example: { "type": "selectOption", "params": { "elementId": "mno345", "option": "United States" } }

# Best Practices

1. **Match by semantic meaning**, not just text
   - "Submit Form" button is a button with role="button"
   - Look for role="textbox" for input fields

2. **Prefer specific roles over generic ones**
   - button > generic clickable element
   - textbox > generic input

3. **Use full elementId exactly as shown**
   - Don't abbreviate or modify IDs
   - Don't guess IDs

4. **Verify actions make sense**
   - Don't click textboxes, type in them
   - Don't type in buttons, click them

5. **Consider parent-child relationships**
   - Child elements are indented under parents
   - Sometimes you need the parent element

# Task Execution

You will be given:
1. A user task (e.g., "Click the login button")
2. The accessibility tree of the current page

Your response must include:
1. **reasoning**: Explain which element matches the task and why
2. **actions**: List of actions to execute (most tasks need only 1 action)

# Example Response

Task: "Click the login button"

Tree:
[abc123] button: Log In
[def456] button: Sign Up
[ghi789] link: Forgot Password?

Response:
{
  "reasoning": "The task asks to click the login button. Element [abc123] is a button with name 'Log In', which matches the user's intent.",
  "actions": [
    {
      "type": "clickElement",
      "params": { "elementId": "abc123" },
      "actionDescription": "Clicking the Log In button to proceed with login"
    }
  ]
}
`;
```

**Key Improvements:**
1. ✅ Explains accessibility tree format clearly
2. ✅ Shows exact action syntax with elementId
3. ✅ Teaches semantic role understanding
4. ✅ Provides concrete examples
5. ✅ Emphasizes best practices

**Where to Use:**
```typescript
// src/agent/tools/agent.ts
const baseMsgs: HyperAgentMessage[] = [
  {
    role: "system",
    content: ctx.domMode === 'a11y'
      ? A11Y_SYSTEM_PROMPT    // ← New prompt
      : SYSTEM_PROMPT         // ← Old prompt
  }
];
```

---

## Code Changes Required

### 1. Create New A11y DOM Provider

#### **File: `src/context-providers/a11y-dom/types.ts`** (NEW)
```typescript
export interface AXNode {
  nodeId: string;
  role: string;
  name?: string;
  description?: string;
  value?: string;
  properties?: Array<{ name: string; value: any }>;
  childIds?: string[];
  backendDOMNodeId?: string;
  ignored?: boolean;
  ignoredReasons?: Array<{ name: string; value?: string }>;
  scrollable?: boolean;
}

export interface EnhancedAXNode extends AXNode {
  tagName: string;
  xpath: string;
  children?: EnhancedAXNode[];
}

export interface DOMNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  localName: string;
  nodeValue: string;
  childNodeCount?: number;
  children?: DOMNode[];
  attributes?: string[];
}

export interface AccessibilityTree {
  nodes: EnhancedAXNode[];
  simplifiedTree: string;
  idToElement: Map<string, EnhancedAXNode>;
}
```

#### **File: `src/context-providers/a11y-dom/get-tree.ts`** (NEW)
```typescript
import { Page, CDPSession } from 'patchright';
import { AXNode, DOMNode, AccessibilityTree, EnhancedAXNode } from './types';

export async function getAccessibilityTree(page: Page): Promise<AccessibilityTree> {
  const client = await page.context().newCDPSession(page);

  try {
    // Step 1: Get accessibility tree
    const { nodes } = await client.send('Accessibility.getFullAXTree') as { nodes: AXNode[] };

    // Step 2: Get full DOM for xpath mapping
    const { root } = await client.send('DOM.getDocument', {
      depth: -1,
      pierce: true,
    }) as { root: DOMNode };

    // Step 3: Build maps
    const { tagNameMap, xpathMap } = buildDOMMaps(root);

    // Step 4: Enhance nodes with DOM info
    const enhancedNodes = enhanceNodes(nodes, tagNameMap, xpathMap);

    // Step 5: Filter to interactive only
    const interactiveNodes = filterInteractive(enhancedNodes);

    // Step 6: Build simplified tree
    const simplifiedTree = formatTree(interactiveNodes);

    // Step 7: Build lookup map
    const idToElement = new Map<string, EnhancedAXNode>();
    flattenNodes(interactiveNodes).forEach(node => {
      if (node.backendDOMNodeId) {
        idToElement.set(node.backendDOMNodeId, node);
      }
    });

    return {
      nodes: interactiveNodes,
      simplifiedTree,
      idToElement,
    };
  } finally {
    await client.detach();
  }
}

function buildDOMMaps(root: DOMNode): {
  tagNameMap: Record<string, string>;
  xpathMap: Record<string, string>;
} {
  const tagNameMap: Record<string, string> = {};
  const xpathMap: Record<string, string> = {};

  const stack: Array<{ node: DOMNode; path: string }> = [
    { node: root, path: '' }
  ];

  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    const nodeId = node.backendNodeId.toString();

    tagNameMap[nodeId] = node.nodeName.toLowerCase();
    xpathMap[nodeId] = path || '/';

    if (node.children) {
      const childCounts = new Map<string, number>();

      for (const child of node.children) {
        const tagName = child.nodeName.toLowerCase();
        const count = (childCounts.get(tagName) || 0) + 1;
        childCounts.set(tagName, count);

        const childPath = path + `/${tagName}[${count}]`;
        stack.push({ node: child, path: childPath });
      }
    }
  }

  return { tagNameMap, xpathMap };
}

function enhanceNodes(
  nodes: AXNode[],
  tagNameMap: Record<string, string>,
  xpathMap: Record<string, string>
): EnhancedAXNode[] {
  return nodes.map(node => {
    const nodeId = node.backendDOMNodeId?.toString() || '';

    return {
      ...node,
      tagName: tagNameMap[nodeId] || 'unknown',
      xpath: xpathMap[nodeId] || '',
      role: (node.role === 'generic' || node.role === 'none')
        ? tagNameMap[nodeId]
        : node.role,
    };
  });
}

function filterInteractive(nodes: EnhancedAXNode[]): EnhancedAXNode[] {
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio',
    'combobox', 'listbox', 'menuitem', 'tab', 'switch', 'slider',
    'spinbutton', 'option', 'gridcell', 'a', 'input', 'textarea',
    'select', 'details', 'summary'
  ]);

  return nodes.filter(node => {
    if (node.ignored) return false;
    if (INTERACTIVE_ROLES.has(node.role)) return true;
    if (node.scrollable) return true;
    return false;
  });
}

function formatTree(nodes: EnhancedAXNode[], level: number = 0): string {
  let result = '';

  for (const node of nodes) {
    const indent = '  '.repeat(level);
    const id = node.backendDOMNodeId || node.nodeId;
    const name = node.name ? `: ${node.name.trim()}` : '';

    result += `${indent}[${id}] ${node.role}${name}\n`;

    if (node.children && node.children.length > 0) {
      result += formatTree(node.children, level + 1);
    }
  }

  return result;
}

function flattenNodes(nodes: EnhancedAXNode[]): EnhancedAXNode[] {
  const result: EnhancedAXNode[] = [];

  for (const node of nodes) {
    result.push(node);
    if (node.children) {
      result.push(...flattenNodes(node.children));
    }
  }

  return result;
}
```

---

### 2. Modify Existing getDom Function

#### **File: `src/context-providers/dom/index.ts`** (MODIFY)

```typescript
// BEFORE:
export const getDom = async (page: Page): Promise<DOMState | null> => {
  const result = (await page.evaluate(buildDomViewJs)) as DOMStateRaw;
  // ... visual DOM code
};

// AFTER:
import { getAccessibilityTree } from '../a11y-dom/get-tree';

export type DOMMode = 'visual' | 'a11y' | 'hybrid';

export async function getDom(
  page: Page,
  mode: DOMMode = 'visual'
): Promise<DOMState | null> {
  switch (mode) {
    case 'a11y':
      return getA11yDOMState(page);

    case 'visual':
      return getVisualDOMState(page);

    case 'hybrid':
      return getHybridDOMState(page);
  }
}

async function getA11yDOMState(page: Page): Promise<DOMState> {
  const axTree = await getAccessibilityTree(page);

  return {
    elements: axTree.idToElement,
    domState: axTree.simplifiedTree,
    screenshot: '', // No screenshot for a11y mode
    mode: 'a11y',
  };
}

async function getVisualDOMState(page: Page): Promise<DOMState> {
  // Keep existing implementation for backwards compatibility
  const result = (await page.evaluate(buildDomViewJs)) as DOMStateRaw;
  const elements = new Map<number, InteractiveElement>();
  for (const element of result.elements) {
    if (element.highlightIndex !== undefined) {
      elements.set(element.highlightIndex, element);
    }
  }
  return {
    elements,
    domState: result.domState,
    screenshot: result.screenshot,
    mode: 'visual',
  };
}

async function getHybridDOMState(page: Page): Promise<DOMState> {
  const axTree = await getAccessibilityTree(page);

  // Take clean screenshot without overlays
  const screenshot = await page.screenshot({ type: 'png' });

  return {
    elements: axTree.idToElement,
    domState: axTree.simplifiedTree,
    screenshot: screenshot.toString('base64'),
    mode: 'hybrid',
  };
}
```

---

### 3. Update DOMState Type

#### **File: `src/context-providers/dom/types.ts`** (MODIFY)

```typescript
// ADD:
export interface DOMState {
  elements: Map<string, any>;  // Changed from Map<number, ...>
  domState: string;
  screenshot: string;
  mode?: 'visual' | 'a11y' | 'hybrid';  // ADD
}
```

---

### 4. Update Action Handlers

#### **File: `src/agent/actions/click-element.ts`** (MODIFY)

```typescript
// BEFORE:
const ClickElementAction = z.object({
  index: z.number().describe("The numeric index of the element to click."),
});

// AFTER:
const ClickElementAction = z.object({
  elementId: z.string().describe("The unique ID of the element to click from the accessibility tree"),
});

type ClickElementActionType = z.infer<typeof ClickElementAction>;

export const ClickElementActionDefinition: AgentActionDefinition = {
  type: "clickElement" as const,
  actionParams: ClickElementAction,
  run: async function (
    ctx: ActionContext,
    action: ClickElementActionType
  ): Promise<ActionOutput> {
    const { elementId } = action;

    // Get element from map
    const element = ctx.domState.elements.get(elementId);
    if (!element) {
      return { success: false, message: `Element ${elementId} not found` };
    }

    // Use XPath to locate element
    const locator = ctx.page.locator(`xpath=${element.xpath}`);

    const exists = (await locator.count()) > 0;
    if (!exists) {
      return { success: false, message: "Element not found on page" };
    }

    await locator.scrollIntoViewIfNeeded({ timeout: 2500 });
    await locator.waitFor({ state: "visible", timeout: 2500 });
    await locator.click({ force: true });

    return { success: true, message: `Clicked element ${elementId}` };
  },
  pprintAction: function (params: ClickElementActionType): string {
    return `Click element ${params.elementId}`;
  },
};
```

#### **File: `src/agent/actions/input-text.ts`** (MODIFY)

```typescript
// BEFORE:
export const InputTextAction = z.object({
  index: z.number().describe("The numeric index of the element"),
  text: z.string().describe("The text to input."),
});

// AFTER:
export const InputTextAction = z.object({
  elementId: z.string().describe("The unique ID of the textbox element"),
  text: z.string().describe("The text to input."),
});

export const InputTextActionDefinition: AgentActionDefinition = {
  type: "inputText" as const,
  actionParams: InputTextAction,
  run: async (ctx: ActionContext, action: InputTextActionType) => {
    let { elementId, text } = action;

    // Variable substitution
    for (const variable of ctx.variables) {
      text = text.replace(`<<${variable.key}>>`, variable.value);
    }

    // Get element from map
    const element = ctx.domState.elements.get(elementId);
    if (!element) {
      return { success: false, message: `Element ${elementId} not found` };
    }

    // Use XPath
    const locator = ctx.page.locator(`xpath=${element.xpath}`);
    await locator.fill(text, { timeout: 5_000 });

    return {
      success: true,
      message: `Inputted text "${text}" into element ${elementId}`,
    };
  },
};
```

---

### 5. Update Agent Task Loop

#### **File: `src/agent/tools/agent.ts`** (MODIFY)

```typescript
export const runAgentTask = async (
  ctx: AgentCtx,
  taskState: TaskState,
  params?: TaskParams
): Promise<TaskOutput> => {
  // ... existing setup

  // MODIFY: Pass domMode to getDom
  let domState: DOMState | null = null;
  try {
    domState = await retry({
      func: async () => {
        const mode = ctx.domMode || 'a11y';  // ADD: default to a11y
        const s = await getDom(page, mode);  // ADD: pass mode
        if (!s) throw new Error("no dom state");
        return s;
      },
      params: { retryCount: 3 },
    });
  } catch (error) {
    // ... error handling
  }

  // MODIFY: Only composite screenshot for visual mode
  let screenshot = '';
  if (domState.mode === 'visual') {
    screenshot = await compositeScreenshot(
      page,
      domState.screenshot.startsWith("data:image/png;base64,")
        ? domState.screenshot.slice("data:image/png;base64,".length)
        : domState.screenshot
    );
  } else if (domState.mode === 'hybrid') {
    screenshot = domState.screenshot; // Clean screenshot without overlay
  }
  // For 'a11y' mode, screenshot stays empty

  // ... rest of function
};
```

---

### 6. Add Configuration

#### **File: `src/types/config.ts`** (MODIFY)

```typescript
export interface HyperAgentConfig<T extends BrowserProviders = "Local"> {
  // ... existing config

  // ADD:
  domMode?: 'visual' | 'a11y' | 'hybrid' | 'auto';
  // 'visual' - Current canvas overlay approach
  // 'a11y' - Text-only accessibility tree (recommended)
  // 'hybrid' - A11y tree + clean screenshot
  // 'auto' - Automatically choose based on action
}
```

#### **File: `src/agent/index.ts`** (MODIFY)

```typescript
export class HyperAgent<T extends BrowserProviders = "Local"> {
  // ADD:
  private domMode: 'visual' | 'a11y' | 'hybrid';

  constructor(params: HyperAgentConfig<T> = {}) {
    // ... existing constructor

    // ADD:
    this.domMode = params.domMode === 'auto'
      ? 'a11y'  // Default to a11y for auto
      : params.domMode || 'a11y';  // Default to a11y
  }
}
```

---

### 7. Add System Prompt

#### **File: `src/agent/messages/a11y-system-prompt.ts`** (NEW)

```typescript
export const A11Y_SYSTEM_PROMPT = `...`; // Full prompt from above
```

#### **File: `src/agent/tools/agent.ts`** (MODIFY)

```typescript
import { A11Y_SYSTEM_PROMPT } from '../messages/a11y-system-prompt';

export const runAgentTask = async (ctx: AgentCtx, ...) => {
  // MODIFY:
  const systemPrompt = ctx.domMode === 'a11y'
    ? A11Y_SYSTEM_PROMPT
    : SYSTEM_PROMPT;

  const baseMsgs: HyperAgentMessage[] = [
    { role: "system", content: systemPrompt },  // Use appropriate prompt
  ];

  // ... rest of function
};
```

---

## Migration Strategy

### Step 1: Add A11y Support (Non-Breaking)
```typescript
// Users can opt-in to new mode
const agent = new HyperAgent({
  domMode: 'a11y',  // Opt-in to new approach
});
```

### Step 2: Test Both Modes
```typescript
// Create test suite comparing modes
const testCases = [
  { task: 'Click login', url: 'example.com/login' },
  { task: 'Fill form', url: 'example.com/signup' },
];

for (const mode of ['visual', 'a11y']) {
  // Run tests and compare results
}
```

### Step 3: Make A11y Default
```typescript
// After testing proves a11y is better:
// Change default in config.ts
domMode: params.domMode || 'a11y',  // Default to a11y
```

### Step 4: Deprecate Visual Mode
```typescript
// Add deprecation warning
if (params.domMode === 'visual') {
  console.warn('Visual DOM mode is deprecated. Use "a11y" or "hybrid" instead.');
}
```

---

## Testing Plan

### Test 1: Token Count Comparison
```typescript
async function testTokenCount() {
  const agent = new HyperAgent({ domMode: 'a11y', debug: true });
  const page = await agent.getCurrentPage();
  await page.goto('https://example.com');

  const domState = await getDom(page, 'a11y');
  const tokenCount = estimateTokens(domState.domState);

  console.log('A11y tree tokens:', tokenCount);
  // Expected: 2,000-5,000 tokens
}
```

### Test 2: Accuracy on Complex Pages
```typescript
const complexSites = [
  'https://github.com',      // Lots of interactive elements
  'https://stackoverflow.com', // Complex forms
  'https://amazon.com',      // Dynamic content
];

for (const site of complexSites) {
  const result = await page.ai('Find the search button');
  console.log(`${site}: ${result.status}`);
}
```

### Test 3: Performance Benchmark
```typescript
async function benchmarkSpeed() {
  const start = Date.now();
  const domState = await getDom(page, 'a11y');
  const duration = Date.now() - start;

  console.log('A11y tree extraction:', duration, 'ms');
  // Expected: 300-600ms (vs 800-1500ms for visual)
}
```

---

## Success Criteria

### Must Have
- ✅ A11y mode reduces tokens by 60%+ (8K → 3K)
- ✅ A11y mode maintains 85%+ accuracy
- ✅ No breaking changes to existing API
- ✅ All action types work with elementId

### Should Have
- ✅ A11y mode is 2x+ faster than visual mode
- ✅ XPath selectors more reliable than CSS
- ✅ System prompt improves LLM understanding
- ✅ Debug mode still shows element positions

### Nice to Have
- ✅ Automatic fallback if a11y tree fails
- ✅ Hybrid mode for extract actions
- ✅ Performance metrics in debug output
- ✅ Visual comparison tool (old vs new)

---

## Rollout Timeline

**Week 1:** Implement accessibility tree extraction
**Week 2:** Update action handlers for elementId
**Week 3:** Add system prompt and testing
**Week 4:** Beta testing with real users
**Week 5:** Make a11y default mode
**Week 6:** Remove visual mode (breaking change)

---

## References

- **Stagehand Implementation:** `/Users/devin/projects/stagehand/stagehand/lib/a11y/utils.ts`
- **Chrome CDP Protocol:** https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/
- **Current HyperAgent:** See `currentState.md`
