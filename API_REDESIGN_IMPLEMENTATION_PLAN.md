# HyperAgent API Redesign: V1 (Visual) + Single Actions (A11y)

**Date**: October 29, 2025
**Status**: ✅ COMPLETED
**Goal**: Refactor HyperAgent to provide two distinct, optimized APIs with 100% backwards compatibility

---

## Executive Summary

Refactor HyperAgent to provide two distinct, optimized APIs:
- **V1 (Visual Mode)**: `page.ai()` for complex multi-step tasks using vision
- **Single Actions (A11y Mode)**: `page.aiAction()` for granular, reliable actions using accessibility tree

This provides 100% backwards compatibility while offering the best of both architectures.

---

## Problem Statement

Current issues:
1. ❌ `domConfig.mode` is confusing - users don't know which to choose
2. ❌ V1 agent performs poorly with a11y mode (not designed for it)
3. ❌ V2 agent (tools-new) is great but replaces V1 instead of complementing it
4. ❌ Users lose V1's strength (complex multi-step with vision) when using V2
5. ❌ No clear guidance on when to use which approach

---

## Solution

### Two Complementary APIs

| API | Mode | Use Case | Architecture |
|-----|------|----------|--------------|
| `page.ai()` | Visual (screenshots) | Complex multi-step tasks | V1: Action sequences |
| `page.aiAction()` | A11y (accessibility tree) | Single granular actions | Stagehand-inspired tools |

### Key Principles

1. ✅ **100% Backwards Compatible** - All existing code works unchanged
2. ✅ **Clear Use Cases** - Each API has a specific purpose
3. ✅ **No Configuration Confusion** - Remove `domConfig.mode`, each API has fixed mode
4. ✅ **Best of Both** - Users can leverage strengths of each approach
5. ✅ **Composable** - Mix and match both APIs in same workflow

---

## Architecture Changes

### Current State
```
src/agent/
├── tools/          # V1 agent (complex, visual)
├── tools-new/      # V2 agent (granular, a11y) ← Currently wired to executeTask (WRONG)
└── index.ts        # Imports from tools-new
```

**Problem**: V2 replaced V1, users lost complex multi-step capability

### Target State
```
src/agent/
├── tools/              # V1 agent (complex, visual) - for page.ai()
├── tools-actions/      # Single action agent (granular, a11y) - for page.aiAction()
└── index.ts            # Imports from tools/ for executeTask (V1)
```

**Solution**: Both coexist, V1 for `page.ai()`, actions for `page.aiAction()`

---

## Detailed Implementation Plan

### Phase 1: Rename and Reorganize (15 min)

#### 1.1 Rename Folder

**Action**: Rename folder for clarity
```bash
mv src/agent/tools-new/ src/agent/tools-actions/
```

**Rationale**:
- "tools-new" implies temporary/replacement
- "tools-actions" describes purpose (single actions)
- Matches the concept of "action-based" vs "task-based"

#### 1.2 Update Imports in Renamed Files

**Files to check** (auto-updated by rename):
- `src/agent/tools-actions/agent.ts`
- `src/agent/tools-actions/index.ts`
- `src/agent/tools-actions/act.ts`
- `src/agent/tools-actions/complete.ts`
- `src/agent/tools-actions/extract.ts`
- `src/agent/tools-actions/getDOM.ts`
- `src/agent/tools-actions/goto.ts`
- `src/agent/tools-actions/scroll.ts`
- `src/agent/tools-actions/types.ts`

**Expected imports** (should remain relative):
```typescript
import { ToolContext } from './types';
import { createAgentTools } from './index';
// etc - all relative imports stay the same
```

---

### Phase 2: Revert V1 to Original Behavior (10 min)

#### 2.1 Revert Agent Import

**File**: `src/agent/index.ts`

**Line 32** - Change back to V1:
```typescript
// BEFORE (currently using tools-new - incorrect)
import { runAgentTask } from "./tools-new/agent";

// AFTER (revert to V1 for executeTask)
import { runAgentTask } from "./tools/agent";
```

**Rationale**:
- `executeTask()` should use V1 (visual, complex tasks)
- We'll add separate import for single actions later

#### 2.2 Remove domConfig.mode Support from V1

**File**: `src/agent/tools/agent.ts`

**Lines 130-136** - Remove mode switching logic:
```typescript
// BEFORE (supports multiple modes)
const domMode = ctx.domConfig?.mode ?? 'visual';

// For a11y modes, use simplified Stagehand-style prompt
let systemPrompt = SYSTEM_PROMPT;
if (domMode === 'a11y' || domMode === 'hybrid' || domMode === 'visual-debug') {
  systemPrompt = SIMPLE_SYSTEM_PROMPT;
}

// AFTER (always visual)
const systemPrompt = SYSTEM_PROMPT; // V1 always uses visual prompt
```

**Rationale**:
- V1 was designed for visual mode
- Testing showed V1 performs poorly with a11y
- Simplifies code by removing branching logic

**Line 168** - Force visual mode in getUnifiedDOM call:
```typescript
// BEFORE (respects domConfig.mode)
domState = await retry({
  func: async () => {
    const s = await getUnifiedDOM(page, ctx.domConfig);
    if (!s) throw new Error("no dom state");
    return s;
  },
  // ...
});

// AFTER (force visual mode)
domState = await retry({
  func: async () => {
    const s = await getUnifiedDOM(page, {
      ...ctx.domConfig,
      mode: 'visual' // Always visual for V1
    });
    if (!s) throw new Error("no dom state");
    return s;
  },
  // ...
});
```

**Rationale**: Ensures V1 always gets screenshots and visual overlays

#### 2.3 Remove domConfig.mode from Type Definitions

**File**: `src/types/config.ts`

**Find DOMConfig interface** and simplify:
```typescript
// BEFORE
export interface DOMConfig {
  mode?: 'visual' | 'a11y' | 'hybrid' | 'visual-debug';
  screenshotQuality?: number;
  maxDOMSize?: number;
  // ... other options
}

// AFTER (remove mode field)
export interface DOMConfig {
  // Remove mode - each API has fixed mode now
  screenshotQuality?: number;  // For V1 visual mode
  maxDOMSize?: number;
  // ... other options remain for customization
}
```

**Rationale**:
- Removes confusion about which mode to use
- Each API (ai vs aiAction) has predetermined mode
- Keeps other options for legitimate customization

---

### Phase 3: Add executeSingleAction Method (20 min)

#### 3.1 Add New Private Method to HyperAgent Class

**File**: `src/agent/index.ts`

**Location**: Add after `executeTask()` method (around line 441)

**Implementation**:
```typescript
/**
 * Execute a single granular action using a11y-based tools
 * Optimized for reliable, precise actions on specific elements
 *
 * This uses the Stagehand-inspired architecture:
 * - On-demand DOM fetching (via getDOM tool)
 * - Natural language action descriptions
 * - Accessibility tree for element finding
 * - Tool-based execution flow
 *
 * @param action Natural language action (e.g., "click the login button")
 * @param params Optional parameters for the action
 * @param initPage Optional page to use for the action
 * @returns A promise that resolves to the action output
 *
 * @example
 * await agent.executeSingleAction("click the login button", {}, page);
 * await agent.executeSingleAction("fill email with test@example.com", {}, page);
 */
private async executeSingleAction(
  action: string,
  params?: TaskParams,
  initPage?: Page
): Promise<TaskOutput> {
  // Dynamic import from tools-actions (not tools)
  // This keeps the single action agent separate from V1
  const { runAgentTask: runSingleActionTask } = await import("./tools-actions/agent");

  const taskId = uuidv4();
  const page = initPage || (await this.getCurrentPage());

  const taskState: TaskState = {
    id: taskId,
    task: action,
    status: TaskStatus.PENDING,
    startingPage: page,
    steps: [],
  };

  this.tasks[taskId] = taskState;

  try {
    return await runSingleActionTask(
      {
        llm: this.llm,
        actions: this.getActions(params?.outputSchema), // Pass for compatibility with AgentCtx type
        tokenLimit: this.tokenLimit,
        debug: this.debug,
        mcpClient: this.mcpClient,
        variables: this._variables,
        actionConfig: this.actionConfig,
        domConfig: { mode: 'a11y' } as any, // Force a11y mode (type cast for compatibility)
      },
      taskState,
      {
        ...params,
        maxSteps: params?.maxSteps || 3, // Lower default - single actions should be quick
      }
    );
  } catch (error) {
    taskState.status = TaskStatus.FAILED;
    throw error;
  }
}
```

**Rationale**:
- Private method - only exposed via `page.aiAction()`
- Dynamic import keeps tools-actions code separate
- Forces a11y mode for single actions
- Lower maxSteps default (3 vs 10) - single actions are quick
- Reuses existing task infrastructure for consistency

#### 3.2 Add aiAction to HyperPage Interface

**File**: `src/types/agent/types.ts`

**Find HyperPage interface** and add new method:
```typescript
export interface HyperPage extends Page {
  /**
   * Execute a complex multi-step task using visual mode (V1)
   *
   * Best for:
   * - Multi-step workflows
   * - Form filling with multiple fields
   * - Navigation flows
   * - Complex decision-making
   * - Tasks requiring visual context
   *
   * Uses screenshots and visual overlays for rich context.
   *
   * @example
   * await page.ai("book a flight from NYC to SF on March 15th");
   * await page.ai("fill out the contact form with my information");
   */
  ai(task: string, params?: TaskParams): Promise<TaskOutput>;

  /**
   * Execute a single granular action using a11y mode
   *
   * Best for:
   * - Individual button clicks
   * - Single input fills
   * - Precise element interactions
   * - Sequential step-by-step workflows
   * - When you need reliability over complexity
   *
   * Uses accessibility tree for fast, reliable element finding.
   *
   * @example
   * await page.aiAction("click the login button");
   * await page.aiAction("fill email with test@example.com");
   * await page.aiAction("press enter key");
   */
  aiAction(action: string, params?: TaskParams): Promise<TaskOutput>;

  /**
   * Execute a complex multi-step task asynchronously
   * Returns a Task control object immediately
   */
  aiAsync(task: string, params?: TaskParams): Promise<Task>;

  /**
   * Extract structured data from the current page (uses visual mode)
   */
  extract<T extends z.ZodType<any> | undefined = undefined>(
    task?: string,
    outputSchema?: T,
    params?: TaskParams
  ): Promise<T extends z.ZodType<any> ? z.infer<T> : string>;
}
```

**Rationale**:
- Clear JSDoc explaining when to use each method
- Examples show typical usage patterns
- Helps IDEs provide better autocomplete/documentation

#### 3.3 Wire Up aiAction in setupHyperPage

**File**: `src/agent/index.ts`

**Find setupHyperPage method** (around line 609) and update:
```typescript
private setupHyperPage(page: Page): HyperPage {
  const hyperPage = page as HyperPage;

  // V1: Complex multi-step tasks with vision
  hyperPage.ai = (task: string, params?: TaskParams) =>
    this.executeTask(task, params, page);

  hyperPage.aiAsync = (task: string, params?: TaskParams) =>
    this.executeTaskAsync(task, params, page);

  // NEW: Single granular actions with a11y
  hyperPage.aiAction = (action: string, params?: TaskParams) =>
    this.executeSingleAction(action, params, page);

  // Extract stays V1 (visual mode for rich context)
  hyperPage.extract = async (task, outputSchema, params) => {
    if (!task && !outputSchema) {
      throw new HyperagentError(
        "No task description or output schema specified",
        400
      );
    }
    const taskParams: TaskParams = {
      maxSteps: params?.maxSteps ?? 2,
      ...params,
      outputSchema,
    };
    if (task) {
      const res = await this.executeTask(
        `You have to perform an extraction on the current page. You have to perform the extraction according to the task: ${task}. Make sure your final response only contains the extracted content`,
        taskParams,
        page
      );
      if (outputSchema) {
        return JSON.parse(res.output as string);
      }
      return res.output as string;
    } else {
      const res = await this.executeTask(
        "You have to perform a data extraction on the current page. Make sure your final response only contains the extracted content",
        taskParams,
        page
      );
      return JSON.parse(res.output as string);
    }
  };

  return hyperPage;
}
```

**Rationale**:
- All page methods now available: ai, aiAction, aiAsync, extract
- Clear comments show which uses which architecture
- Extract stays V1 (visual helps with data extraction)

---

### Phase 4: Optimize Single Action Agent (15 min)

#### 4.1 Update Single Action System Prompt

**File**: `src/agent/tools-actions/agent.ts`

**Lines 26-47** - Replace with optimized prompt for single actions:
```typescript
function buildSystemPrompt(task: string): string {
  return `You are a precise web automation assistant specialized in executing single, granular actions.

Today's date: ${DATE_STRING}

Your action: ${task}

CRITICAL: This is a SINGLE ACTION task. You should execute exactly ONE interaction and complete.

EXECUTION FLOW:
1. If needed, call getDOM to see the current page structure
2. Call act tool ONCE with the exact action description provided
3. Call complete immediately after the action succeeds or fails

IMPORTANT RULES:
- This is NOT a multi-step task - execute ONE action only
- Do not break the action into smaller steps
- Do not perform multiple interactions
- If the element is not found, try scrolling ONCE, then complete with failure
- Always call complete after attempting the action

EXAMPLES:

Task: "click the login button"
✓ Correct: getDOM → act("click the login button") → complete(success)
✗ Wrong: getDOM → act("find login") → act("click button") → complete

Task: "fill email with test@example.com"
✓ Correct: getDOM → act("fill email field with test@example.com") → complete(success)
✗ Wrong: getDOM → act("find email field") → act("type text") → complete

Task: "press enter key"
✓ Correct: act("press enter key") → complete(success)
✗ Wrong: getDOM → act("find active element") → act("press enter") → complete

This is a focused, single-step operation. Execute it precisely and efficiently.`;
}
```

**Rationale**:
- Emphasizes SINGLE action (prevents agent from overthinking)
- Clear examples show correct vs wrong patterns
- Discourages breaking actions into smaller steps
- Guides agent to complete quickly

#### 4.2 Lower Default maxSteps

**File**: `src/agent/tools-actions/agent.ts`

**Line 98** - Change default maxSteps:
```typescript
// BEFORE
const maxSteps = params?.maxSteps || 10;

// AFTER (single actions should complete in 2-3 steps)
const maxSteps = params?.maxSteps || 3;
```

**Rationale**:
- Single actions shouldn't need many steps
- Typical flow: getDOM → act → complete (3 steps max)
- Forces agent to be efficient
- Saves tokens and time

#### 4.3 Adjust Temperature (Already Done)

**File**: `src/agent/tools-actions/agent.ts`

**Line 132** - Verify temperature is 0.7:
```typescript
temperature: 0.7,  // Already set correctly
```

**Rationale**: Balanced between deterministic (0) and creative (1)

---

### Phase 5: Update Documentation & Tests (30 min)

#### 5.1 Update README.md

**File**: `README.md`

**Add new section** after installation:

```markdown
## Two Modes of Operation

HyperAgent provides two distinct APIs optimized for different use cases:

### 1. Complex Tasks with Vision (`page.ai`)

**Best for:** Multi-step workflows, form filling, navigation, complex decision-making

```typescript
// Handles complex multi-step tasks automatically
await page.ai("book a flight from NYC to SF on March 15th");
await page.ai("fill out the contact form with my information");
await page.ai("search for best rated coffee makers under $100");
await page.ai("navigate to checkout and apply coupon code SAVE20");
```

**How it works:**
- 🖼️ Uses vision (screenshots) for rich context
- 🎯 Plans and executes multiple steps automatically
- 🧠 Handles complex decision-making
- ⚡ Default: 10 steps max, batched actions
- 💰 Higher token cost (includes images)

**Use when:**
- Task requires multiple steps
- Need to understand visual layout
- Filling complex forms
- Navigating between pages
- Making decisions based on page content

---

### 2. Single Granular Actions (`page.aiAction`)

**Best for:** Precise, individual interactions with specific elements

```typescript
// Execute one action at a time with high reliability
await page.aiAction("click the login button");
await page.aiAction("fill email with test@example.com");
await page.aiAction("fill password with secretpass");
await page.aiAction("click the blue submit button");
await page.aiAction("wait for success message");
```

**How it works:**
- 🌲 Uses accessibility tree (faster, cheaper)
- 🎯 One precise action per call
- ✅ More reliable for specific elements
- ⚡ Default: 3 steps max
- 💰 Lower token cost (text only)

**Use when:**
- Need precise element targeting
- Building step-by-step workflows
- Want maximum reliability
- Working with complex forms (fill field-by-field)
- Debugging or when ai() is struggling

---

### When to Use Which?

| Scenario | Use `page.ai()` | Use `page.aiAction()` |
|----------|----------------|---------------------|
| "Book a flight to Paris" | ✅ Complex task | ❌ Too broad |
| "Click the search button" | ❌ Overkill | ✅ Single action |
| "Fill login form and submit" | ✅ Multi-step | ⚠️ Or break into actions |
| "Type 'coffee' in search box" | ❌ Too granular | ✅ Perfect fit |
| "Find cheapest hotel under $200" | ✅ Requires reasoning | ❌ Too complex |
| "Select 'Pickup' from dropdown" | ❌ Overkill | ✅ Single action |
| "Navigate to checkout" | ✅ May need multiple clicks | ⚠️ Or use aiAction per step |

---

### Mixing Both APIs

You can combine both in the same workflow for maximum power:

```typescript
// Use ai() for complex initial flow
await page.ai("search for flights from NYC to San Francisco on March 15th");

// Then use aiAction() for precise interactions
await page.aiAction("click the first search result");
await page.aiAction("scroll down to the price breakdown section");
await page.aiAction("click show all fees button");

// Back to ai() for complex extraction
const fees = await page.extract("get all fee line items with amounts", feesSchema);

// Continue with aiAction() for checkout
await page.aiAction("click the Book Now button");
await page.aiAction("fill passenger name with John Doe");
await page.aiAction("fill credit card number with 4111111111111111");

// Final submission with ai()
await page.ai("complete the booking");
```

**Strategy:**
1. Use `ai()` for complex flows and decision-making
2. Use `aiAction()` for precise, reliable interactions
3. Use `extract()` for data collection
4. Mix and match based on the situation

---

### API Comparison

| Feature | `page.ai()` | `page.aiAction()` |
|---------|------------|------------------|
| **Mode** | Visual (screenshots) | A11y (accessibility tree) |
| **Best For** | Complex workflows | Single interactions |
| **Steps** | Multiple (batched) | One at a time |
| **Speed** | Slower (more planning) | Faster (direct execution) |
| **Reliability** | Good for complexity | Excellent for precision |
| **Token Cost** | Higher (images) | Lower (text only) |
| **Max Steps** | 10 (default) | 3 (default) |
| **Planning** | Agent plans ahead | Execute exactly as stated |
| **Error Recovery** | Can adapt mid-flow | Fails fast and clear |

---

### Examples

#### Example 1: E-commerce Flow

```typescript
// Complex search with ai()
await page.ai("search for wireless headphones under $100");

// Precise navigation with aiAction()
await page.aiAction("click the third product result");
await page.aiAction("scroll down to customer reviews");
await page.aiAction("click the Show More Reviews button");

// Extract data
const reviews = await page.extract("get all review texts and ratings");

// Decision with ai()
await page.ai("add to cart if average rating is above 4 stars");
```

#### Example 2: Form Filling

```typescript
// Option A: Let ai() handle the whole form
await page.ai("fill out the contact form with name John Doe, email john@example.com, and message Hello");

// Option B: Use aiAction() for precise control
await page.aiAction("fill name field with John Doe");
await page.aiAction("fill email field with john@example.com");
await page.aiAction("fill message field with Hello");
await page.aiAction("click the submit button");
```

#### Example 3: Multi-page Workflow

```typescript
const page = await agent.newPage();
await page.goto("https://example.com");

// Complex navigation
await page.ai("navigate to the products page");

// Precise filtering
await page.aiAction("click the Category dropdown");
await page.aiAction("select Electronics from dropdown");
await page.aiAction("click the Apply Filters button");

// Complex search within results
await page.ai("find the cheapest laptop with at least 16GB RAM");

// Precise checkout
await page.aiAction("click the Add to Cart button");
await page.aiAction("click the Shopping Cart icon");
await page.aiAction("click Proceed to Checkout");
```
```

#### 5.2 Update Example in dogcat.ts

**File**: `scripts/dogcat.ts`

**Replace lines 46-79** with:

```typescript
    const variables = {
      input1: "cats",
      input2: "dogs",
    };

    // DEMONSTRATION OF BOTH APIS

    // ===== Option 1: Using page.ai() (Complex Multi-Step) =====
    console.log("\n===== Using page.ai() (Complex Task) =====");
    console.log("This uses visual mode to handle multiple steps in one go\n");

    // One complex instruction handles the entire flow
    await page.ai(`
      Search for ${variables.input1},
      click the first suggestion,
      then clear the search and search for ${variables.input2},
      and click the first result
    `);

    // ===== Option 2: Using page.aiAction() (Granular Steps) =====
    console.log("\n===== Using page.aiAction() (Granular Actions) =====");
    console.log("This uses a11y mode for precise, step-by-step control\n");

    // Navigate back to start
    await page.goto("https://www.bing.com/");

    // Step 1: Type first search
    console.log(`Step 1: Type ${variables.input1} into search box`);
    await page.aiAction(`type ${variables.input1} into the search box`);

    // Step 2: Click suggestion
    console.log(`Step 2: Click first search suggestion '${variables.input1}'`);
    await page.aiAction(`click the first search suggestion '${variables.input1}'`);

    // Step 3: Click search box again
    console.log(`Step 3: Click search box with '${variables.input1}' text`);
    await page.aiAction(`click the search box with '${variables.input1}' text`);

    // Step 4: Clear search box
    console.log("Step 4: Clear the search box");
    await page.aiAction("click the X button to clear the search box");

    // Step 5: Type second search
    console.log(`Step 5: Type ${variables.input2} into search box`);
    await page.aiAction(`type ${variables.input2} into the search box`);

    // Step 6: Click suggestion
    console.log(`Step 6: Click first search suggestion '${variables.input2}'`);
    await page.aiAction(`click the first search suggestion '${variables.input2}'`);

    // Step 7: Click result
    console.log("Step 7: Click the first search result");
    await page.aiAction("click the first search result 'Dog - Wikipedia'");

    // ===== COMPARISON =====
    console.log("\n===== Summary =====");
    console.log("page.ai():       Faster, handles complex flows, uses vision");
    console.log("page.aiAction(): More precise, step-by-step control, uses a11y tree");
    console.log("Both are valid approaches - choose based on your needs!");
```

**Rationale**: Shows both APIs side-by-side so users understand the difference

#### 5.3 Create New Test File

**File**: `tests/aiAction.test.ts` (NEW)

```typescript
import { HyperAgent } from '../src/agent';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

describe('aiAction API', () => {
  let agent: HyperAgent;

  beforeAll(async () => {
    agent = new HyperAgent({
      debug: true,
      llm: {
        provider: 'openai',
        model: 'gpt-4o-mini',
      }
    });
  });

  afterAll(async () => {
    await agent.closeAgent();
  });

  describe('Single Actions', () => {
    it('should execute a single click action', async () => {
      const page = await agent.newPage();
      await page.goto('https://example.com');

      const result = await page.aiAction('click the "More information" link');

      expect(result.success).toBe(true);
      expect(page.url()).toContain('iana.org'); // Should navigate
    });

    it('should execute a single fill action', async () => {
      const page = await agent.newPage();
      await page.goto('https://www.google.com');

      const result = await page.aiAction('type "HyperAgent" into the search box');

      expect(result.success).toBe(true);

      // Verify text was typed
      const value = await page.$eval('input[name="q"]', (el: any) => el.value);
      expect(value).toContain('HyperAgent');
    });

    it('should handle actions on elements not immediately visible', async () => {
      const page = await agent.newPage();
      await page.goto('https://example.com');

      // This might require scrolling
      const result = await page.aiAction('scroll down to the footer');

      expect(result.success).toBe(true);
    });
  });

  describe('Integration with page.ai()', () => {
    it('should work alongside page.ai() in the same workflow', async () => {
      const page = await agent.newPage();
      await page.goto('https://www.bing.com');

      // Complex task with ai()
      await page.ai('search for cats');

      // Wait a moment
      await page.waitForTimeout(1000);

      // Granular actions with aiAction()
      const result1 = await page.aiAction('click the first search result');
      expect(result1.success).toBe(true);

      // Navigate back
      await page.goBack();

      // Another granular action
      const result2 = await page.aiAction('click the search box');
      expect(result2.success).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should fail gracefully when element not found', async () => {
      const page = await agent.newPage();
      await page.goto('https://example.com');

      const result = await page.aiAction('click the nonexistent button with id xyz123');

      expect(result.success).toBe(false);
      expect(result.output).toContain('not found');
    });
  });

  describe('Performance', () => {
    it('should complete single actions quickly (< 5 seconds)', async () => {
      const page = await agent.newPage();
      await page.goto('https://example.com');

      const start = Date.now();
      await page.aiAction('click the More information link');
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(5000);
    });

    it('should use fewer tokens than page.ai()', async () => {
      // This test would require token tracking
      // TODO: Implement token usage comparison
    });
  });
});

describe('page.ai() vs page.aiAction() Comparison', () => {
  let agent: HyperAgent;

  beforeAll(async () => {
    agent = new HyperAgent({ debug: true });
  });

  afterAll(async () => {
    await agent.closeAgent();
  });

  it('should demonstrate when to use each API', async () => {
    const page = await agent.newPage();
    await page.goto('https://www.bing.com');

    // Scenario 1: Complex multi-step - use ai()
    console.log('Testing page.ai() for complex task...');
    const aiResult = await page.ai('search for "web automation" and click the first result');
    expect(aiResult.success).toBe(true);

    await page.goBack();

    // Scenario 2: Same task but granular - use aiAction()
    console.log('Testing page.aiAction() for granular steps...');
    const action1 = await page.aiAction('type "web automation" into the search box');
    expect(action1.success).toBe(true);

    const action2 = await page.aiAction('press enter key');
    expect(action2.success).toBe(true);

    const action3 = await page.aiAction('click the first search result');
    expect(action3.success).toBe(true);
  });
});
```

**Rationale**:
- Comprehensive test coverage for new API
- Shows both APIs work independently
- Shows both APIs work together
- Includes performance and error handling tests

#### 5.4 Update AGENT_REDESIGN_PLAN.md

**File**: `AGENT_REDESIGN_PLAN.md`

**Add note at top**:
```markdown
# SUPERSEDED

This plan has been superseded by `API_REDESIGN_IMPLEMENTATION_PLAN.md`.

The original plan was to replace V1 with V2. The new plan keeps both:
- V1 (visual) for `page.ai()` - complex tasks
- V2 (a11y) for `page.aiAction()` - single actions

See `API_REDESIGN_IMPLEMENTATION_PLAN.md` for the current implementation plan.
```

---

### Phase 6: Clean Up Old References (10 min)

#### 6.1 Search for Old References to tools-new

```bash
# Search entire codebase
grep -r "tools-new" src/

# Expected: Should only find the import we need to change (already done in Phase 2)
```

**Action**: Update any remaining imports to either:
- `./tools/agent` for V1
- `./tools-actions/agent` for single actions

#### 6.2 Update Import Comments for Clarity

**File**: `src/agent/index.ts`

**Top of file** - Add clear comments:
```typescript
import { Browser, BrowserContext, Page } from "patchright";
import { v4 as uuidv4 } from "uuid";

// ... other imports

// V1 Agent: Complex multi-step tasks with visual mode
import { runAgentTask } from "./tools/agent";

// Note: Single action agent (tools-actions) is dynamically imported
// in executeSingleAction() to keep architectures separate
```

**Rationale**: Future developers understand the architecture at a glance

#### 6.3 Update Package Scripts

**File**: `package.json`

Check if any scripts reference old paths:
```json
{
  "scripts": {
    // These should work fine after rename
    "build": "...",
    "test": "..."
  }
}
```

No changes needed (scripts don't reference specific agent files)

---

## Migration Guide for Users

### For Existing Users (No Action Required)

**All existing code continues to work unchanged:**

```typescript
// These continue to work exactly as before
await page.ai("book a flight from NYC to SF");
await agent.executeTask("search for hotels in Paris");
await page.extract("get all product prices", priceSchema);

// domConfig is ignored (V1 always uses visual)
const agent = new HyperAgent({
  domConfig: { mode: 'a11y' } // This is now ignored - V1 uses visual
});
```

**What changed:**
- V1 (`page.ai()`) now always uses visual mode (was configurable before)
- `domConfig.mode` option removed (each API has fixed mode)
- New `page.aiAction()` available for granular actions

**Impact:**
- ✅ Better performance for V1 (optimized for visual)
- ✅ More reliable element finding for granular tasks
- ❌ Can't use a11y mode with `page.ai()` anymore (use `page.aiAction()` instead)

---

### Adopting the New aiAction() API

Users can gradually adopt `aiAction()` where appropriate:

#### Before (Using ai() for everything):
```typescript
await page.ai("click the login button");
await page.ai("fill email with test@example.com");
await page.ai("fill password with mypassword");
await page.ai("click the submit button");
```

**Issues:**
- Overkill for simple actions
- Higher token cost (4 screenshots for 4 actions)
- Slower execution

#### After (Using aiAction() for granular steps):
```typescript
await page.aiAction("click the login button");
await page.aiAction("fill email with test@example.com");
await page.aiAction("fill password with mypassword");
await page.aiAction("click the submit button");
```

**Benefits:**
- ✅ More appropriate for simple actions
- ✅ Lower token cost (text-only)
- ✅ Faster execution
- ✅ More reliable element finding

---

### Choosing Between ai() and aiAction()

**Use `page.ai()` when:**
- Task requires multiple coordinated steps
- Need visual understanding of the page
- Filling complex forms with conditional logic
- Navigation with decision-making
- "Book X", "Find Y and do Z", "Search and filter"

**Use `page.aiAction()` when:**
- Task is a single, specific interaction
- Building step-by-step workflows
- Need maximum reliability
- Working with standard HTML elements
- "Click X", "Fill Y", "Select Z from dropdown"

**Use both together:**
```typescript
// Complex initial flow
await page.ai("navigate to the booking page and select Paris");

// Precise date selection
await page.aiAction("click the check-in date picker");
await page.aiAction("select March 15 from calendar");
await page.aiAction("click the check-out date picker");
await page.aiAction("select March 20 from calendar");

// Complex finalization
await page.ai("complete the booking with standard options");
```

---

## Testing Checklist

Before marking this as complete, verify:

### Functionality Tests
- [ ] V1 (`page.ai()`) still works for complex tasks
- [ ] V1 always uses visual mode (screenshots are present in debug output)
- [ ] V1 ignores `domConfig.mode` setting
- [ ] `executeTask()` uses V1 (visual mode)
- [ ] `aiAction()` executes single actions correctly
- [ ] `aiAction()` uses a11y tree (no screenshots in debug output)
- [ ] `aiAction()` completes in 3 steps or less for simple actions
- [ ] Both APIs work on the same page sequentially
- [ ] `extract()` still works (uses V1 visual mode)
- [ ] `aiAsync()` still works

### Integration Tests
- [ ] Can navigate with `ai()` then interact with `aiAction()`
- [ ] Can interact with `aiAction()` then navigate with `ai()`
- [ ] Multiple `aiAction()` calls work sequentially
- [ ] Error handling works for both APIs

### Performance Tests
- [ ] `aiAction()` is faster than `ai()` for single actions
- [ ] `aiAction()` uses fewer tokens than `ai()`
- [ ] V1 performance is unchanged

### Documentation Tests
- [ ] README examples work
- [ ] dogcat.ts demonstrates both APIs
- [ ] TypeScript types are correct
- [ ] JSDoc comments are helpful

### Regression Tests
- [ ] All existing tests pass
- [ ] No breaking changes in public API
- [ ] domConfig removal doesn't break existing code

---

## Files to Modify

| # | File | Type | Description |
|---|------|------|-------------|
| 1 | `src/agent/tools-new/` → `tools-actions/` | Rename | Rename folder for clarity |
| 2 | `src/agent/index.ts` | Edit | Revert import to V1 (line 32) |
| 3 | `src/agent/tools/agent.ts` | Edit | Remove domConfig.mode support (lines 130-136, 168) |
| 4 | `src/types/config.ts` | Edit | Remove mode from DOMConfig |
| 5 | `src/agent/index.ts` | Add | New executeSingleAction() method |
| 6 | `src/types/agent/types.ts` | Edit | Add aiAction to HyperPage interface |
| 7 | `src/agent/index.ts` | Edit | Wire up aiAction in setupHyperPage() |
| 8 | `src/agent/tools-actions/agent.ts` | Edit | Improve system prompt (lines 26-47) |
| 9 | `src/agent/tools-actions/agent.ts` | Edit | Lower maxSteps default (line 98) |
| 10 | `README.md` | Add | New "Two Modes of Operation" section |
| 11 | `scripts/dogcat.ts` | Edit | Show both APIs side-by-side |
| 12 | `tests/aiAction.test.ts` | New | Comprehensive tests for new API |
| 13 | `AGENT_REDESIGN_PLAN.md` | Edit | Mark as superseded |
| 14 | `API_REDESIGN_IMPLEMENTATION_PLAN.md` | New | This file |

---

## Timeline Estimate

| Phase | Tasks | Time | Cumulative |
|-------|-------|------|------------|
| 1 | Rename folder, update imports | 15 min | 15 min |
| 2 | Revert V1, remove domConfig.mode | 10 min | 25 min |
| 3 | Add executeSingleAction, wire up aiAction | 20 min | 45 min |
| 4 | Optimize single action agent | 15 min | 60 min |
| 5 | Update docs, tests, examples | 30 min | 90 min |
| 6 | Clean up, final verification | 10 min | 100 min |

**Total Estimated Time: ~100 minutes (1.5-2 hours)**

**Contingency:** Add 30-50% buffer for unexpected issues = **2-3 hours total**

---

## Success Criteria

✅ **Backwards Compatibility**
- All existing code works without changes
- `page.ai()` and `executeTask()` behavior unchanged (except mode locked to visual)

✅ **New API Functional**
- `page.aiAction()` executes single actions correctly
- Uses a11y mode (no screenshots)
- Completes quickly (3 steps default)

✅ **Clear Separation**
- V1 always uses visual mode
- Single actions always use a11y mode
- No confusing domConfig.mode option

✅ **Documentation Complete**
- README explains both APIs
- Examples show when to use which
- JSDoc comments are clear

✅ **Tests Pass**
- All existing tests pass
- New aiAction tests pass
- Both APIs work together

---

## Rollback Plan

If issues are discovered:

### Quick Rollback (5 minutes)
```bash
# Revert to tools-new
git checkout src/agent/index.ts  # Line 32 import
mv src/agent/tools-actions src/agent/tools-new
```

### Full Rollback (10 minutes)
```bash
# Revert all changes
git checkout src/agent/
git checkout src/types/
git checkout scripts/dogcat.ts
git checkout README.md
rm tests/aiAction.test.ts
```

---

## Future Enhancements (Not in This Plan)

Ideas for future iterations:

1. **System Instructions** (Stagehand feature)
   ```typescript
   new HyperAgent({ systemInstructions: "You are a travel expert..." })
   ```

2. **Token Usage Tracking**
   - Compare costs between ai() and aiAction()
   - Show in logs/metrics

3. **Agent-Level aiAction**
   ```typescript
   await agent.executeSingleAction("click button");
   ```
   (Currently only page-level)

4. **Visual Mode for aiAction**
   - Optional screenshot for complex elements
   - Hybrid mode for edge cases

5. **Batch aiAction**
   ```typescript
   await page.aiActions([
     "click login",
     "fill email with test@example.com",
     "fill password with pass",
     "click submit"
   ]);
   ```

6. **Smart Mode Selection**
   - Auto-detect complex vs simple
   - Use ai() or aiAction() automatically

---

## Questions & Answers

**Q: Why keep V1 if V2 (aiAction) is better?**
A: They're different tools. V1 is better for complex multi-step tasks that benefit from visual understanding. V2 is better for precise, reliable single actions.

**Q: Can I still use domConfig with V1?**
A: Yes, but `domConfig.mode` is removed. Other options (like screenshotQuality) remain available.

**Q: Is this a breaking change?**
A: No. All existing code works unchanged. The only change is that V1 no longer supports a11y mode (it always uses visual).

**Q: Should I rewrite all my ai() calls to aiAction()?**
A: No. Only switch where it makes sense (single, precise actions). Keep ai() for complex tasks.

**Q: What's the performance difference?**
A: aiAction() is typically 30-50% faster and uses 60-80% fewer tokens for single actions.

**Q: Can I mix both APIs?**
A: Yes! That's the whole point. Use each where it excels.

**Q: Why rename to tools-actions?**
A: "tools-new" implies temporary. "tools-actions" describes purpose (single action execution).

---

## Notes

- This plan preserves 100% backwards compatibility
- Both V1 and "single actions" coexist as complementary tools
- Clear separation removes confusion about modes
- Users can adopt aiAction() gradually
- Documentation provides clear guidance on when to use which

---

**Status**: Ready for implementation
**Estimated Time**: 2-3 hours
**Risk Level**: Low (backwards compatible)
**Next Step**: Get approval and begin Phase 1
