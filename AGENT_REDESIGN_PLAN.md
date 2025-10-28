# HyperAgent Architecture Redesign Plan

## Executive Summary

HyperAgent's current agent implementation has fundamental architectural issues causing infinite loops and poor task completion. After comprehensive analysis comparing with Stagehand's proven architecture, we've identified the root causes and designed a solution that combines the best of both approaches.

**Timeline**: 2-3 weeks
**Risk**: Medium (major refactor, but can be incremental)
**Impact**: Fixes infinite loops, improves accuracy, reduces token usage

---

## Table of Contents

1. [Root Cause Analysis](#root-cause-analysis)
2. [Architecture Comparison](#architecture-comparison)
3. [Detailed Solution Design](#detailed-solution-design)
4. [Implementation Phases](#implementation-phases)
5. [Migration Strategy](#migration-strategy)
6. [Testing & Validation](#testing--validation)
7. [Stagehand Features Analysis](#stagehand-features-analysis)
8. [Open Questions & Decisions](#open-questions--decisions)

---

## Root Cause Analysis

### Why Does HyperAgent Get Stuck in Loops?

#### Problem 1: Information Overload Every Loop

**Current Behavior:**
```typescript
// Every loop iteration:
1. Fetch full DOM tree (can be 70k tokens)
2. Show entire tree to agent
3. Agent must parse everything
4. Return structured JSON
5. Execute action
6. Repeat from step 1
```

**Issue:** Agent sees the SAME massive tree even when page hasn't changed significantly. This:
- Wastes tokens (70k × number of steps)
- Overwhelms agent's reasoning
- Makes it hard to track what changed
- Forces agent to re-analyze everything each time

**Stagehand's Approach:**
```typescript
// Only fetch DOM when agent explicitly requests it
1. Agent reasons about task
2. Agent: "I need to see the page" → calls ariaTree tool
3. System returns tree
4. Agent acts based on what it saw
5. Only fetches DOM again if needed
```

**Why This Matters:** Agent can reason WITHOUT seeing the full page, then request info only when needed. This reduces token usage by 80-90%.

---

#### Problem 2: Rigid Structured Output

**Current System:**
```typescript
// Agent MUST return this exact structure every time:
{
  "thoughts": "...",
  "memory": "...",
  "nextGoal": "...",
  "actions": [
    {
      "type": "clickElement",
      "params": { "elementId": "0-1234" },
      "actionDescription": "..."
    }
  ]
}
```

**Issues:**
1. **Can't think naturally**: Agent forced into specific format, can't say "wait, I need more info"
2. **Must pick exact elementId**: Agent has to choose `"0-1234"` from tree, can't say "click the login button"
3. **No clarification**: If ambiguous, agent can't ask questions, must guess
4. **Action description redundant**: Already in structured format, description is repetitive

**Stagehand's Approach:**
```typescript
// Agent reasons naturally, calls tools when ready:
Agent: "I need to log in. Let me check what's on the page."
Agent: [calls ariaTree tool]
System: [returns tree]
Agent: "I see a 'Sign In' button. I'll click it."
Agent: [calls act("click the Sign In button")]
System: "Successfully clicked button"
Agent: "Login successful!"
Agent: [calls close with success: true]
```

**Why This Matters:** Natural language is much easier for LLM to reason with. Less cognitive overhead = better decisions.

---

#### Problem 3: Element Selection Burden

**Current System:**
```
Agent sees tree:
[0-1234] button: Login
[0-5678] button: Sign In
[0-9012] button: Create Account

Agent must:
1. Understand task: "click login button"
2. Read entire tree
3. Match "login" to either "Login" or "Sign In"
4. Pick exact elementId
5. Return { "elementId": "0-1234" }
```

**Issue:** Agent doing TWO jobs:
1. **Intent matching**: "login button" → "Sign In button"
2. **Element finding**: Find `[0-1234]` in tree

**Stagehand's Approach:**
```typescript
// Agent just describes WHAT to do:
Agent: [calls act("click the login button")]

// System uses observe() to find element:
function observe(instruction, tree):
  1. Calls LLM: "Find element matching 'login button' in this tree"
  2. LLM returns: "0-1234" with confidence 0.9
  3. System clicks element
  4. Returns: "Successfully clicked [0-1234] button: Sign In"
```

**Why This Matters:**
- **Separation of concerns**: Agent focuses on strategy, system handles tactics
- **Better accuracy**: Dedicated LLM call for element finding (can use smaller, faster model)
- **Clearer errors**: If element not found, system can retry or report clearly

---

#### Problem 4: Poor Feedback Loop

**Current System:**
```json
// Previous actions shown as JSON:
{
  "idx": 0,
  "agentOutput": {
    "thoughts": "I'll click the clear button",
    "actions": [{"type": "clickElement", "params": {"elementId": "0-8188"}}]
  },
  "actionOutputs": [
    {"success": true, "message": "Clicked element with ID 0-8188"}
  ]
}
```

**Issues:**
1. **Not conversational**: Hard for agent to understand action outcomes
2. **Success ≠ Goal achieved**: `success: true` means "clicked", not "task done"
3. **No context**: Agent sees "Clicked element" but doesn't know what happened after

**Example of confusion:**
```
Step 0: Agent clicks "Clear text" button → success: true
Step 1: Agent sees search box still has text in autocomplete suggestions
Step 1: Agent thinks: "Clearing didn't work, let me try again"
Step 2: Agent scrolls looking for clear button
... infinite loop
```

**Stagehand's Approach:**
```
Messages accumulate as conversation:

User: "Click the X button to clear the search box"

Agent: "I'll check the current page first."
Agent: [calls ariaTree]

System: "Accessibility tree: [0-1234] button: Clear text ..."

Agent: "I can see a 'Clear text' button. I'll click it."
Agent: [calls act("click the Clear text button")]

System: "Successfully clicked [0-1234] button: Clear text. The search box is now empty."

Agent: "Task complete! The search box has been cleared."
Agent: [calls close with success: true]
```

**Why This Matters:** Natural conversation makes outcomes clear. Agent can see causality.

---

#### Problem 5: Task Completion Detection

**Current System:**
Agent must explicitly call `complete` action. But agent often:
1. Thinks task needs more steps (when it's done)
2. Doesn't realize page state changed (element disappeared)
3. Keeps trying same action (loop)

**Stagehand's Approach:**
- `maxSteps` hard limit (default: 10)
- If agent doesn't call `close` tool by step 10, task ends
- Agent can call `close` at any time with `success: true/false`

**Why This Matters:** Hard limits prevent infinite loops. Agent forced to make completion decision.

---

## Architecture Comparison

### Full Comparison Table

| Feature | **HyperAgent (Current)** | **Stagehand** | **Recommendation** |
|---------|--------------------------|---------------|-------------------|
| **Agent Loop** | Custom while loop | AI SDK `generateText` with tools | Use AI SDK (proven, maintained) |
| **System Prompt** | 500+ lines (combined prompts) | 30 lines (tool-focused) | Adopt Stagehand's simplicity |
| **DOM Fetching** | Pre-fetch every iteration | On-demand via `ariaTree` tool | On-demand (80% token savings) |
| **Action Selection** | Agent picks elementId directly | Agent describes action → observe finds element | Two-step (better accuracy) |
| **Action Format** | `{ type: "clickElement", params: { elementId: "0-1234" }}` | `act("click login button")` | Natural language actions |
| **Task Completion** | `complete` action in structured output | `close` tool with success boolean | Use `close` tool |
| **Feedback** | JSON in previous actions | Natural conversation messages | Natural messages |
| **Error Handling** | Agent sees `success: false` in JSON | Tool returns error string | Natural error messages |
| **Max Steps** | Optional parameter, no hard enforcement | Hard limit (default: 10) | Enforce hard limit |
| **Temperature** | 0 (deterministic) | 1 (creative) | Test both, likely 0.7 |
| **Structured Output** | Required (Zod schema) | Optional (natural tool calling) | Remove requirement |
| **Screenshot** | Pre-composited with overlays | On-demand via `screenshot` tool | On-demand (token savings) |
| **Extraction** | Part of agent output | Dedicated `extract` tool | Separate tool (cleaner) |
| **Navigation** | Actions in agent output | `goto`, `navback`, `refresh` tools | Dedicated tools |
| **Scrolling** | Action in agent output | `scroll` tool with pixels | Tool-based |
| **Wait** | Fixed 2s after each action | `wait` tool with ms parameter | Configurable wait tool |
| **Logging** | Console.log | Structured logger with categories | Add structured logging |
| **Metrics** | None | Token usage, inference time tracked | Add metrics tracking |
| **Conversation** | System → User → Assistant repeat | Natural multi-turn with tools | Natural conversation |

---

## Detailed Solution Design

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      User Task Request                       │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                 HyperAgent (New Architecture)                │
│                                                              │
│  ┌────────────────────────────────────────────────────┐   │
│  │         AI SDK generateText with tools             │   │
│  │  - System Prompt (30 lines)                        │   │
│  │  - Messages: [user task, tool results...]          │   │
│  │  - Tools: getDOM, act, extract, complete, etc.     │   │
│  │  - MaxSteps: 10 (hard limit)                       │   │
│  │  - Temperature: 0.7                                 │   │
│  └────────────────────────────────────────────────────┘   │
│                            ↓                                 │
│  Agent calls tools as needed:                               │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │  getDOM  │  │   act    │  │  extract │  │ complete │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
│       ↓              ↓              ↓              ↓        │
└───────┼──────────────┼──────────────┼──────────────┼────────┘
        │              │              │              │
        ↓              ↓              ↓              ↓
┌─────────────────────────────────────────────────────────────┐
│                      Tool Implementations                     │
│                                                              │
│  getDOM:     → Get a11y tree → Return as tool result        │
│  act:        → Call observe() → Find element → Execute       │
│  extract:    → Use LLM to extract data from tree            │
│  complete:   → Mark task done → Return final result          │
│  scroll:     → Scroll page → Return new scroll position      │
│  screenshot: → Take screenshot → Return base64               │
│  goto:       → Navigate to URL → Wait for load               │
└─────────────────────────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────────────────────────┐
│                    Observe Function                          │
│                                                              │
│  Input: "click the login button"                            │
│  Process:                                                    │
│    1. Get current a11y tree from context                    │
│    2. Call LLM: "Find element for: click login button"      │
│    3. LLM returns: { elementId: "0-1234", confidence: 0.9 } │
│    4. Return element info                                    │
└─────────────────────────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────────────────────────┐
│                   Action Execution Layer                     │
│                                                              │
│  1. Get Playwright locator from elementId                   │
│  2. Use xpathMap to find element                            │
│  3. Execute Playwright action (click, fill, etc.)           │
│  4. Return success/failure with descriptive message         │
└─────────────────────────────────────────────────────────────┘
```

---

## Implementation Phases

### Phase 1: Create Observe Function (Week 1)

**Goal:** Implement Stagehand-style observe that finds elements from natural language.

**Why First:** This is the foundation. Without observe, we can't do natural language actions.

#### 1.1 Create Observe Types

**File:** `src/agent/observe/types.ts` (NEW)

```typescript
/**
 * Result from observe function
 */
export interface ObserveResult {
  /** The element ID in encoded format (e.g., "0-1234") */
  elementId: string;

  /** Human-readable description of the element */
  description: string;

  /** Confidence score 0-1 */
  confidence: number;

  /** Playwright method to use (click, fill, select, etc.) */
  method?: PlaywrightMethod;

  /** Arguments for the method */
  arguments?: any[];
}

export type PlaywrightMethod =
  | 'click'
  | 'fill'
  | 'selectOption'
  | 'hover'
  | 'press';

export interface ObserveContext {
  /** Current a11y tree as text */
  tree: string;

  /** Map of elementIds to xpaths */
  xpathMap: Record<string, string>;

  /** Map of elementIds to element objects */
  elements: Map<string, any>;

  /** Current page URL */
  url: string;
}
```

**Reasoning:**
- `ObserveResult` matches Stagehand's return format
- Includes confidence score for handling ambiguity
- Stores method/arguments so observe can suggest how to interact
- `ObserveContext` provides all info observe needs without re-fetching

---

#### 1.2 Implement Observe Function

**File:** `src/agent/observe/index.ts` (NEW)

```typescript
import { LLMClient } from '@/llm/types';
import { ObserveContext, ObserveResult } from './types';
import { buildObserveSystemPrompt, buildObserveUserPrompt } from './prompts';

/**
 * Find elements in the accessibility tree matching the instruction
 *
 * This is similar to Stagehand's observe but optimized for our architecture.
 *
 * @param instruction - Natural language instruction (e.g., "click the login button")
 * @param context - Current page context with a11y tree
 * @param llmClient - LLM client for making inference calls
 * @returns Array of matching elements sorted by confidence
 */
export async function observe(
  instruction: string,
  context: ObserveContext,
  llmClient: LLMClient
): Promise<ObserveResult[]> {
  // Build prompt for element finding
  const systemPrompt = buildObserveSystemPrompt();
  const userPrompt = buildObserveUserPrompt(instruction, context.tree);

  // Call LLM with structured output to find elements
  const response = await llmClient.invokeStructured(
    {
      schema: ObserveResultsSchema, // Zod schema for array of ObserveResult
      options: {
        temperature: 0, // Deterministic for element finding
      },
    },
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]
  );

  if (!response.parsed || response.parsed.elements.length === 0) {
    // No elements found
    return [];
  }

  // Sort by confidence descending
  const results = response.parsed.elements.sort(
    (a, b) => b.confidence - a.confidence
  );

  return results;
}
```

**Reasoning:**
- Separate LLM call for element finding (like Stagehand)
- Can use different model (e.g., gpt-4o-mini for cost savings)
- Returns multiple matches with confidence (agent can pick best)
- Temperature 0 for deterministic element finding

---

#### 1.3 Create Observe Prompts

**File:** `src/agent/observe/prompts.ts` (NEW)

```typescript
export function buildObserveSystemPrompt(): string {
  return `You are an element finder for web automation. Given an accessibility tree and an instruction, find the best matching element.

# Accessibility Tree Format

Each line represents an element:
[elementId] role: name

Example:
[0-1234] button: Login
[0-5678] textbox: Email address
[0-9012] link: Sign up

# Your Task

Find the element(s) that best match the given instruction.

Return:
1. elementId - The exact ID from the tree
2. description - Human-readable description
3. confidence - How confident you are (0-1)
4. method - Playwright method to use (optional)
5. arguments - Method arguments (optional)

# Matching Rules

1. **Exact role match preferred**
   - "click button" → look for role="button"
   - "fill email" → look for role="textbox"

2. **Semantic name matching**
   - "login button" matches "Sign In", "Log In", "Login"
   - "email field" matches "Email address", "Your email", "E-mail"

3. **Context awareness**
   - If multiple matches, prefer the most prominent (earlier in tree)
   - Consider parent-child relationships

4. **Return multiple if ambiguous**
   - If uncertain, return top 3 matches
   - Use confidence scores to indicate certainty

# Examples

Instruction: "click the login button"
Tree: [0-1234] button: Sign In

Response:
{
  "elements": [{
    "elementId": "0-1234",
    "description": "Sign In button",
    "confidence": 0.95,
    "method": "click"
  }]
}

Instruction: "fill the email field"
Tree: [0-5678] textbox: Email address

Response:
{
  "elements": [{
    "elementId": "0-5678",
    "description": "Email address input",
    "confidence": 0.9,
    "method": "fill",
    "arguments": ["<value>"]
  }]
}`;
}

export function buildObserveUserPrompt(
  instruction: string,
  tree: string
): string {
  return `Instruction: ${instruction}

Accessibility Tree:
${tree}

Find the element(s) that best match this instruction.`;
}
```

**Reasoning:**
- Clear, focused prompt for element finding only
- Examples show exact format expected
- Explains confidence scoring (helps with ambiguity)
- Method/arguments suggestion helps agent know how to use element

---

#### 1.4 Add Observe Schema

**File:** `src/agent/observe/schema.ts` (NEW)

```typescript
import { z } from 'zod';

export const ObserveResultSchema = z.object({
  elementId: z.string().describe('The exact elementId from the tree (e.g., "0-1234")'),
  description: z.string().describe('Human-readable description of the element'),
  confidence: z.number().min(0).max(1).describe('Confidence score 0-1'),
  method: z.enum(['click', 'fill', 'selectOption', 'hover', 'press']).optional(),
  arguments: z.array(z.any()).optional(),
});

export const ObserveResultsSchema = z.object({
  elements: z.array(ObserveResultSchema).describe('Array of matching elements, sorted by confidence'),
});
```

**Reasoning:**
- Structured output ensures consistent format
- Validation ensures elementId format is correct
- Array allows multiple matches (agent can pick best)

---

#### 1.5 Test Observe Standalone

**File:** `tests/observe.test.ts` (NEW)

```typescript
import { observe } from '../src/agent/observe';

describe('observe function', () => {
  it('should find exact button match', async () => {
    const tree = `
[0-1234] button: Login
[0-5678] button: Sign Up
[0-9012] textbox: Email
    `.trim();

    const context = {
      tree,
      xpathMap: {},
      elements: new Map(),
      url: 'https://example.com',
    };

    const results = await observe(
      'click the login button',
      context,
      llmClient
    );

    expect(results).toHaveLength(1);
    expect(results[0].elementId).toBe('0-1234');
    expect(results[0].confidence).toBeGreaterThan(0.8);
  });

  it('should handle ambiguous instructions', async () => {
    const tree = `
[0-1234] button: Login
[0-5678] button: Sign In
    `.trim();

    const results = await observe(
      'click the login button',
      context,
      llmClient
    );

    // Should return both with confidence scores
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].confidence).toBeGreaterThan(results[1]?.confidence || 0);
  });
});
```

**Reasoning:**
- Test observe in isolation before integrating
- Verify it handles exact matches, ambiguity, no matches
- Can iterate on prompts without touching agent loop

---

### Phase 2: Implement Tool-Based Actions (Week 1-2)

**Goal:** Create tools that agent can call naturally (like Stagehand).

#### 2.1 Create Tool Types

**File:** `src/agent/tools/types.ts` (NEW)

```typescript
import { z } from 'zod';

export interface Tool {
  name: string;
  description: string;
  parameters: z.ZodObject<any>;
  execute: (params: any, context: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  page: Page;
  llm: LLMClient;
  logger: Logger;
  currentTree?: string;
  currentXpathMap?: Record<string, string>;
  currentElements?: Map<string, any>;
}

export interface ToolResult {
  success: boolean;
  message: string;
  data?: any;
}
```

**Reasoning:**
- Standard interface for all tools
- `ToolContext` provides access to page, LLM, current DOM state
- `ToolResult` standardizes return format for conversation

---

#### 2.2 Implement Core Tools

**File:** `src/agent/tools/getDOM.ts` (NEW)

```typescript
import { tool } from 'ai';
import { z } from 'zod';

export const getDOM = tool({
  description: 'Get the accessibility tree of the current page. Use this to understand what elements are available before taking actions.',
  parameters: z.object({}),
  execute: async (params, context) => {
    // Fetch a11y tree
    const domState = await getUnifiedDOM(context.page, { mode: 'a11y' });

    if (!domState) {
      return {
        success: false,
        message: 'Failed to fetch page structure',
      };
    }

    // Store in context for other tools
    context.currentTree = domState.domState;
    context.currentXpathMap = domState.xpathMap;
    context.currentElements = domState.elements;

    // Truncate if too long
    let tree = domState.domState;
    if (tree.length > 50000) {
      tree = tree.substring(0, 50000) + '\n\n[TRUNCATED: Tree too large]';
    }

    return {
      success: true,
      message: `Current page structure:\n${tree}`,
      data: {
        url: context.page.url(),
        elementCount: domState.elements.size,
      },
    };
  },
});
```

**Reasoning:**
- On-demand fetching (only when agent calls tool)
- Returns tree as natural text message
- Stores in context so other tools can use without re-fetching
- Truncates if too large (prevents token overflow)

---

**File:** `src/agent/tools/act.ts` (NEW)

```typescript
import { tool } from 'ai';
import { z } from 'zod';
import { observe } from '../observe';

export const act = tool({
  description: 'Perform an action on the page. Describe the action in natural language (e.g., "click the login button", "fill the email field with test@example.com").',
  parameters: z.object({
    action: z.string().describe('Description of the action to perform'),
  }),
  execute: async ({ action }, context) => {
    // Ensure we have current DOM state
    if (!context.currentTree) {
      // Auto-fetch if not available
      const domState = await getUnifiedDOM(context.page, { mode: 'a11y' });
      if (!domState) {
        return {
          success: false,
          message: 'Cannot perform action: page structure unavailable',
        };
      }
      context.currentTree = domState.domState;
      context.currentXpathMap = domState.xpathMap;
      context.currentElements = domState.elements;
    }

    // Use observe to find element
    const observeContext = {
      tree: context.currentTree,
      xpathMap: context.currentXpathMap || {},
      elements: context.currentElements || new Map(),
      url: context.page.url(),
    };

    const results = await observe(action, observeContext, context.llm);

    if (results.length === 0) {
      return {
        success: false,
        message: `Could not find element for action: "${action}"`,
      };
    }

    const bestMatch = results[0];

    // Get locator from elementId
    const actionContext = {
      domState: {
        elements: context.currentElements,
        xpathMap: context.currentXpathMap,
      },
      page: context.page,
    };

    const locator = getLocator(actionContext, bestMatch.elementId);

    if (!locator) {
      return {
        success: false,
        message: `Found element [${bestMatch.elementId}] but could not create locator`,
      };
    }

    // Execute action based on method
    try {
      if (bestMatch.method === 'click') {
        await locator.click();
        return {
          success: true,
          message: `Successfully clicked [${bestMatch.elementId}] ${bestMatch.description}`,
        };
      } else if (bestMatch.method === 'fill') {
        const text = bestMatch.arguments?.[0] || extractTextFromAction(action);
        await locator.fill(text);
        return {
          success: true,
          message: `Successfully filled [${bestMatch.elementId}] ${bestMatch.description} with "${text}"`,
        };
      } else if (bestMatch.method === 'selectOption') {
        const option = bestMatch.arguments?.[0] || extractTextFromAction(action);
        await locator.selectOption({ label: option });
        return {
          success: true,
          message: `Successfully selected "${option}" in [${bestMatch.elementId}] ${bestMatch.description}`,
        };
      } else {
        // Default to click
        await locator.click();
        return {
          success: true,
          message: `Successfully interacted with [${bestMatch.elementId}] ${bestMatch.description}`,
        };
      }
    } catch (error) {
      return {
        success: false,
        message: `Failed to perform action on [${bestMatch.elementId}]: ${error.message}`,
      };
    }
  },
});

/**
 * Extract text to input from action string
 * e.g., "fill email field with test@example.com" → "test@example.com"
 */
function extractTextFromAction(action: string): string {
  const match = action.match(/with\s+(.+)$/i);
  return match ? match[1].trim() : '';
}
```

**Reasoning:**
- Two-step process: observe finds element, then execute action
- Natural language in, descriptive result out
- Auto-fetches DOM if not cached (convenience)
- Returns clear success/failure messages for agent to understand
- Extracts text from action description (e.g., "with test@example.com")

---

**File:** `src/agent/tools/complete.ts` (NEW)

```typescript
import { tool } from 'ai';
import { z } from 'zod';

export const complete = tool({
  description: 'Mark the task as complete. Use when the goal has been achieved or if it cannot be completed.',
  parameters: z.object({
    success: z.boolean().describe('True if task completed successfully, false if failed'),
    message: z.string().describe('Description of what was accomplished or why it failed'),
  }),
  execute: async ({ success, message }, context) => {
    context.taskCompleted = true;
    context.taskSuccess = success;

    return {
      success: true,
      message: `Task marked as ${success ? 'completed' : 'failed'}: ${message}`,
      data: {
        completed: true,
        success,
      },
    };
  },
});
```

**Reasoning:**
- Simple completion tool like Stagehand's `close`
- Returns success/failure + reasoning
- Sets flags in context to stop agent loop

---

**File:** `src/agent/tools/scroll.ts` (NEW)

```typescript
export const scroll = tool({
  description: 'Scroll the page up or down. Use when you need to see content that is not currently visible.',
  parameters: z.object({
    direction: z.enum(['up', 'down']).describe('Direction to scroll'),
    amount: z.number().optional().describe('Pixels to scroll (default: 500)'),
  }),
  execute: async ({ direction, amount = 500 }, context) => {
    const scrollAmount = direction === 'down' ? amount : -amount;

    await context.page.evaluate((pixels) => {
      window.scrollBy(0, pixels);
    }, scrollAmount);

    // Wait for any dynamic content to load
    await context.page.waitForTimeout(500);

    // Get new scroll position
    const scrollInfo = await context.page.evaluate(() => {
      return {
        scrollTop: window.scrollY,
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: window.innerHeight,
      };
    });

    const pixelsAbove = scrollInfo.scrollTop;
    const pixelsBelow = scrollInfo.scrollHeight - scrollInfo.scrollTop - scrollInfo.clientHeight;

    return {
      success: true,
      message: `Scrolled ${direction} ${amount}px. Now ${pixelsBelow}px below and ${pixelsAbove}px above viewport.`,
      data: scrollInfo,
    };
  },
});
```

**Reasoning:**
- Returns scroll position info (agent can see if reached bottom)
- Waits for content to load after scrolling
- Clear message helps agent understand page state

---

**File:** `src/agent/tools/extract.ts` (NEW)

```typescript
export const extract = tool({
  description: 'Extract data from the current page. Describe what information you want to extract.',
  parameters: z.object({
    instruction: z.string().describe('What data to extract (e.g., "product prices", "article title")'),
    schema: z.any().optional().describe('Optional JSON schema for structured extraction'),
  }),
  execute: async ({ instruction, schema }, context) => {
    if (!context.currentTree) {
      const domState = await getUnifiedDOM(context.page, { mode: 'a11y' });
      if (!domState) {
        return {
          success: false,
          message: 'Cannot extract: page structure unavailable',
        };
      }
      context.currentTree = domState.domState;
    }

    // Use LLM to extract data from tree
    const extractPrompt = `Extract the following information from this page:

Instruction: ${instruction}

Accessibility Tree:
${context.currentTree}

Extract the requested information in a structured format.${schema ? `\n\nUse this schema: ${JSON.stringify(schema)}` : ''}`;

    const response = await context.llm.invoke(
      [
        {
          role: 'system',
          content: 'You are a data extraction assistant. Extract the requested information from the accessibility tree.',
        },
        {
          role: 'user',
          content: extractPrompt,
        },
      ]
    );

    return {
      success: true,
      message: `Extracted: ${response.text}`,
      data: response.text,
    };
  },
});
```

**Reasoning:**
- Dedicated tool for extraction (cleaner than mixing with actions)
- Can accept optional schema for structured extraction
- Uses current tree (no need to re-fetch)

---

#### 2.3 Register Tools

**File:** `src/agent/tools/index.ts` (UPDATE)

```typescript
import { getDOM } from './getDOM';
import { act } from './act';
import { complete } from './complete';
import { scroll } from './scroll';
import { extract } from './extract';
import { screenshot } from './screenshot';
import { goto } from './goto';

export const agentTools = {
  getDOM,
  act,
  complete,
  scroll,
  extract,
  screenshot,
  goto,
};

export type AgentToolName = keyof typeof agentTools;
```

**Reasoning:**
- All tools in one place
- Export as object for AI SDK
- Type-safe tool names

---

### Phase 3: Rewrite Agent Loop (Week 2)

**Goal:** Replace custom loop with AI SDK's `generateText` + tools approach.

#### 3.1 New Agent Function

**File:** `src/agent/tools/agent-v2.ts` (NEW)

```typescript
import { generateText } from 'ai';
import { agentTools } from './index';

export async function runAgentTaskV2(
  ctx: AgentCtx,
  taskState: TaskState,
  params?: TaskParams
): Promise<TaskOutput> {
  const maxSteps = params?.maxSteps || 10;

  // Simple system prompt (like Stagehand)
  const systemPrompt = buildSimpleSystemPrompt(taskState.task);

  // Initial user message
  const messages = [
    {
      role: 'user' as const,
      content: `Task: ${taskState.task}\nCurrent URL: ${taskState.startingPage.url()}`,
    },
  ];

  // Tool context shared across all tool calls
  const toolContext: ToolContext = {
    page: taskState.startingPage,
    llm: ctx.llm,
    logger: ctx.logger,
    taskCompleted: false,
    taskSuccess: false,
  };

  try {
    const result = await generateText({
      model: ctx.llm.getLanguageModel(),
      system: systemPrompt,
      messages,
      tools: agentTools,
      maxSteps,
      temperature: 0.7, // Balance between deterministic and creative
      toolChoice: 'auto',
      onStepFinish: async (event) => {
        // Log each step
        if (event.toolCalls && event.toolCalls.length > 0) {
          for (const toolCall of event.toolCalls) {
            ctx.logger.info(`[Agent] Called tool: ${toolCall.toolName}`, toolCall.args);
          }
        }

        if (event.text) {
          ctx.logger.info(`[Agent] Reasoning: ${event.text}`);
        }

        // Check if task completed
        if (toolContext.taskCompleted) {
          // Stop agent loop
          return;
        }
      },
    });

    return {
      status: toolContext.taskCompleted && toolContext.taskSuccess
        ? TaskStatus.COMPLETED
        : TaskStatus.FAILED,
      steps: convertToAgentSteps(result),
      output: result.text,
    };
  } catch (error) {
    return {
      status: TaskStatus.FAILED,
      steps: [],
      error: error.message,
    };
  }
}

function buildSimpleSystemPrompt(task: string): string {
  return `You are a web automation assistant. Your goal is to accomplish the user's task using the provided tools.

Your task: ${task}

# Available Tools

- **getDOM**: Get the current page structure (accessibility tree)
- **act**: Perform an action (e.g., "click the login button", "fill email with test@example.com")
- **extract**: Extract data from the current page
- **scroll**: Scroll up or down on the page
- **complete**: Mark the task as done (success or failure)

# Strategy

1. **Understand the page**: Call getDOM to see what's available
2. **Take actions**: Use act to interact with elements
3. **Verify**: After each action, call getDOM again to see if the page changed as expected
4. **Extract if needed**: Use extract to get data
5. **Complete**: When done (or if stuck), call complete with success/failure

# Important

- Start by calling getDOM to understand the page
- Be patient: after each act, wait and check the new page state
- If an action fails 3 times, try a different approach or complete with failure
- If you can't find what you need, scroll or complete with explanation

Remember: You have ${maxSteps || 10} steps max. Use them wisely.`;
}
```

**Reasoning:**
- Uses AI SDK's proven `generateText` with tools
- Simple prompt focused on task goal
- `onStepFinish` hook for logging and completion detection
- Shared `toolContext` allows tools to communicate state
- Temperature 0.7 balances determinism with creativity
- Hard `maxSteps` limit prevents infinite loops

---

#### 3.2 Migration Helper

**File:** `src/agent/tools/agent.ts` (UPDATE)

```typescript
export async function runAgentTask(
  ctx: AgentCtx,
  taskState: TaskState,
  params?: TaskParams
): Promise<TaskOutput> {
  // Feature flag for choosing architecture
  const useV2 = ctx.experimental?.useToolBasedAgent ?? false;

  if (useV2) {
    return runAgentTaskV2(ctx, taskState, params);
  }

  // Fall back to existing implementation
  return runAgentTaskV1(ctx, taskState, params);
}

// Rename existing function
async function runAgentTaskV1(/* existing code */) {
  // ... existing implementation
}
```

**Reasoning:**
- Gradual migration with feature flag
- Can A/B test both architectures
- Backwards compatibility maintained

---

### Phase 4: Update System Prompts (Week 2)

**Goal:** Simplify prompts to match Stagehand's clarity.

#### 4.1 Simple System Prompt

Already shown in Phase 3.1 above. Key principles:

1. **Short** (~30 lines vs 500+)
2. **Tool-focused** (list tools, not action schemas)
3. **Strategy guidance** (high-level, not prescriptive)
4. **Trust LLM** (don't over-specify format)

**Why This Works:**
- LLM knows how to use tools naturally
- Clear goal > rigid format
- Less prompt engineering = more maintainable

---

### Phase 5: Testing & Validation (Week 3)

**Goal:** Ensure new architecture works better than current.

#### 5.1 Create Test Suite

**File:** `tests/agent-v2.test.ts` (NEW)

```typescript
describe('Agent V2 (Tool-Based)', () => {
  it('should complete simple click task', async () => {
    const result = await runAgentTaskV2(ctx, {
      task: 'Click the login button',
      startingPage: page,
      status: TaskStatus.RUNNING,
      steps: [],
    });

    expect(result.status).toBe(TaskStatus.COMPLETED);
    expect(result.output).toContain('login');
  });

  it('should not loop infinitely', async () => {
    const result = await runAgentTaskV2(
      ctx,
      {
        task: 'Click search suggestion that does not exist',
        startingPage: page,
        status: TaskStatus.RUNNING,
        steps: [],
      },
      { maxSteps: 10 }
    );

    // Should complete within maxSteps
    expect(result.steps.length).toBeLessThanOrEqual(10);
  });

  it('should use observe to find elements', async () => {
    // Mock observe to track calls
    const observeSpy = jest.spyOn(observeModule, 'observe');

    await runAgentTaskV2(ctx, {
      task: 'Click the login button',
      startingPage: page,
      status: TaskStatus.RUNNING,
      steps: [],
    });

    // Verify observe was called
    expect(observeSpy).toHaveBeenCalled();
  });
});
```

**Reasoning:**
- Test key scenarios: simple task, missing element, loops
- Verify observe integration
- Ensure maxSteps enforced

---

#### 5.2 Compare Performance

**File:** `tests/architecture-comparison.test.ts` (NEW)

```typescript
describe('V1 vs V2 Performance', () => {
  const testTasks = [
    'Click the login button',
    'Fill email field with test@example.com and submit',
    'Scroll down and click the first search result',
    'Extract the product price',
  ];

  it('should use fewer tokens in V2', async () => {
    const v1Results = [];
    const v2Results = [];

    for (const task of testTasks) {
      // Run V1
      const v1Result = await runAgentTaskV1(ctx, { task, ... });
      v1Results.push(v1Result.tokenUsage);

      // Run V2
      const v2Result = await runAgentTaskV2(ctx, { task, ... });
      v2Results.push(v2Result.tokenUsage);
    }

    const v1Avg = average(v1Results);
    const v2Avg = average(v2Results);

    expect(v2Avg).toBeLessThan(v1Avg * 0.5); // At least 50% reduction
  });

  it('should have higher success rate in V2', async () => {
    const v1Success = await runBenchmark(testTasks, runAgentTaskV1);
    const v2Success = await runBenchmark(testTasks, runAgentTaskV2);

    expect(v2Success).toBeGreaterThanOrEqual(v1Success);
  });
});
```

**Reasoning:**
- Quantify improvements
- Verify V2 is better, not just different
- Can show metrics to justify refactor

---

## Migration Strategy

### Option A: Gradual Migration (Recommended)

**Timeline:** 2-3 weeks

**Week 1:**
- ✅ Implement observe function
- ✅ Test observe standalone
- ✅ Verify it works for element finding

**Week 2:**
- ✅ Implement tool-based actions
- ✅ Create agent-v2.ts alongside agent.ts
- ✅ Add feature flag to switch between V1/V2
- ✅ Test both in parallel

**Week 3:**
- ✅ Run benchmarks (token usage, success rate)
- ✅ If V2 better, make it default
- ✅ Deprecate V1 (keep for compatibility)
- ✅ Update documentation

**Advantages:**
- Lower risk (can rollback anytime)
- Can compare both architectures
- Users choose when to migrate

**Disadvantages:**
- Maintain two codebases temporarily
- More testing needed

---

### Option B: Full Rewrite (Aggressive)

**Timeline:** 1-2 weeks

**Week 1:**
- 🔥 Delete old agent.ts
- ✅ Implement all phases at once
- ✅ Update all tests
- ✅ Breaking change

**Week 2:**
- ✅ Fix issues
- ✅ Update documentation

**Advantages:**
- Faster (no dual maintenance)
- Clean slate

**Disadvantages:**
- Higher risk
- Breaking change for users
- Harder to debug if issues

---

### Recommendation: Option A

Gradual migration allows us to:
1. Validate observe function works well
2. Compare architectures with real metrics
3. Keep backwards compatibility
4. Lower risk of breaking existing users

---

## Stagehand Features Analysis

### Features We're Adopting

| Feature | Stagehand | HyperAgent V2 | Why |
|---------|-----------|---------------|-----|
| **Tool-based actions** | ✅ | ✅ | Natural language actions, better UX |
| **On-demand DOM** | ✅ | ✅ | 80% token reduction |
| **Observe function** | ✅ | ✅ | Separates "what" from "how" |
| **Simple prompt** | ✅ | ✅ | Easier to maintain, LLM understands better |
| **MaxSteps limit** | ✅ | ✅ | Prevents infinite loops |
| **Natural conversation** | ✅ | ✅ | Better agent reasoning |
| **Tool results as messages** | ✅ | ✅ | Clearer feedback loop |

### Features We're NOT Adopting (With Reasoning)

#### 1. Screenshot Tool (Not Adopting Initially)

**Stagehand:** Has `screenshot` tool agent can call

**HyperAgent V2:** Will NOT include initially

**Reasoning:**
- A11y tree usually sufficient for actions
- Screenshots add token cost
- Can add later if needed
- Hybrid mode already has screenshots when needed

**Decision:** Add as Phase 6 (optional) if users request it

---

#### 2. Google CUA Client (Not Adopting)

**Stagehand:** Has experimental Google CUA integration

**HyperAgent V2:** Will NOT include

**Reasoning:**
- Experimental in Stagehand (not stable)
- Adds complexity
- Our focus is OpenAI/Anthropic
- Can add later if there's demand

**Decision:** Out of scope for this redesign

---

#### 3. MCP Integration (Already Have)

**Stagehand:** Doesn't have MCP

**HyperAgent:** Already has MCP support

**Reasoning:**
- We're ahead here
- Keep our MCP integration
- Don't remove it

**Decision:** Keep existing MCP, no changes needed

---

#### 4. Multiple Model Support (Already Have)

**Stagehand:** OpenAI-focused

**HyperAgent:** Supports OpenAI, Anthropic, Google

**Reasoning:**
- We're ahead here
- Maintain our multi-provider support
- Don't regress to OpenAI-only

**Decision:** Keep our LLM abstraction layer

---

#### 5. Structured Logging (Adopting Partially)

**Stagehand:** Has detailed category-based logging

**HyperAgent V2:** Will add basic structured logging

**Reasoning:**
- Helpful for debugging
- Stagehand's approach is good
- Can adopt their logger format

**Decision:** Add in Phase 3.5 (optional)

```typescript
// Add to tool context
interface Logger {
  info: (message: string, aux?: any) => void;
  warn: (message: string, aux?: any) => void;
  error: (message: string, aux?: any) => void;
}

// Use in tools
context.logger.info('[act] Clicking element', { elementId, description });
```

---

#### 6. Usage Metrics (Adopting)

**Stagehand:** Tracks token usage, inference time per action

**HyperAgent V2:** Will add metrics tracking

**Reasoning:**
- Important for monitoring
- Helps optimize costs
- Easy to add with AI SDK

**Decision:** Add in Phase 3.5

```typescript
export interface AgentMetrics {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  inferenceTimeMs: number;
  toolCalls: number;
}

// Track in agent loop
const metrics: AgentMetrics = {
  totalTokens: result.usage.totalTokens,
  promptTokens: result.usage.promptTokens,
  completionTokens: result.usage.completionTokens,
  inferenceTimeMs: Date.now() - startTime,
  toolCalls: result.steps.filter(s => s.toolCalls?.length > 0).length,
};
```

---

#### 7. Iframe Support (Not Adopting Initially)

**Stagehand:** Special handling for iframes in observe

**HyperAgent V2:** Will NOT include initially

**Reasoning:**
- Edge case (not many sites use iframes)
- Adds complexity
- Can add later if needed

**Decision:** Phase 7 (future work) if users need it

---

#### 8. Message Processing Middleware (Adopting Concept)

**Stagehand:** Has middleware to process messages before sending to LLM

**HyperAgent V2:** Will add basic middleware

**Reasoning:**
- Useful for truncating long trees
- Can add custom processing
- AI SDK supports middleware

**Decision:** Add in Phase 3.5

```typescript
const wrappedModel = wrapLanguageModel({
  model: baseModel,
  middleware: {
    transformParams: async ({ params }) => {
      // Truncate long tool results
      const processedMessages = params.messages.map(msg => {
        if (msg.content && typeof msg.content === 'string' && msg.content.length > 50000) {
          return {
            ...msg,
            content: msg.content.substring(0, 50000) + '\n\n[TRUNCATED]',
          };
        }
        return msg;
      });
      return { ...params, messages: processedMessages };
    },
  },
});
```

---

### Features Summary Table

| Feature | Stagehand | Current HyperAgent | New HyperAgent V2 | Decision |
|---------|-----------|-------------------|-------------------|----------|
| Tool-based actions | ✅ | ❌ | ✅ | **Adopt** |
| On-demand DOM | ✅ | ❌ | ✅ | **Adopt** |
| Observe function | ✅ | ❌ | ✅ | **Adopt** |
| Simple prompt | ✅ | ❌ | ✅ | **Adopt** |
| MaxSteps | ✅ | ⚠️ (not enforced) | ✅ | **Adopt** |
| Natural conversation | ✅ | ❌ | ✅ | **Adopt** |
| Screenshot tool | ✅ | ❌ | 🔮 | **Future** |
| Google CUA | ✅ (experimental) | ❌ | ❌ | **Skip** |
| MCP | ❌ | ✅ | ✅ | **Keep ours** |
| Multi-model | ⚠️ (OpenAI focus) | ✅ | ✅ | **Keep ours** |
| Structured logging | ✅ | ⚠️ (basic) | ✅ | **Adopt** |
| Usage metrics | ✅ | ❌ | ✅ | **Adopt** |
| Iframe support | ✅ | ❌ | 🔮 | **Future** |
| Message middleware | ✅ | ❌ | ✅ | **Adopt** |

**Legend:**
- ✅ = Has feature
- ❌ = Does not have
- ⚠️ = Partial
- 🔮 = Planned for future

---

## Open Questions & Decisions

### Question 1: Structured Output vs Natural Tool Calling?

**Context:** Stagehand uses natural tool calling (AI SDK's default). We currently use structured output with Zod schemas.

**Option A: Natural Tool Calling (Stagehand's way)**
```typescript
// Agent returns natural language, AI SDK handles tool calling
Agent: "I'll click the login button"
Agent: [calls act("click the login button")]
```

**Option B: Structured Output (Our current way)**
```typescript
// Agent returns structured JSON
{
  "actions": [{
    "type": "act",
    "params": { "action": "click the login button" }
  }]
}
```

**Recommendation:** **Option A** (Natural Tool Calling)

**Reasoning:**
- More flexible (agent can reason between tools)
- Better for complex tasks requiring multiple steps
- Matches Stagehand's proven approach
- Less cognitive overhead for LLM

---

### Question 2: Temperature Setting?

**Context:** Stagehand uses temperature 1.0, we currently use 0.

**Options:**
- **0**: Fully deterministic (current)
- **0.7**: Balanced (recommended)
- **1.0**: Creative (Stagehand)

**Recommendation:** **0.7**

**Reasoning:**
- Temperature 0 can be too rigid (misses nuances)
- Temperature 1.0 can be too random (inconsistent)
- 0.7 balances determinism with creativity
- Good for natural language tasks

---

### Question 3: Should We Auto-Fetch DOM or Require Tool Call?

**Context:** Stagehand requires agent to call `ariaTree` tool. We could auto-provide it.

**Option A: Require Tool Call (Pure Stagehand)**
```
Agent must explicitly call getDOM to see page
```

**Option B: Auto-Provide First Time (Hybrid)**
```
First iteration: Show DOM automatically
Subsequent: Agent must call getDOM if needed
```

**Recommendation:** **Option A** (Require Tool Call)

**Reasoning:**
- Forces agent to think before acting
- More token-efficient (only fetch when needed)
- Matches Stagehand's design philosophy
- Agent learns to call getDOM when needed

---

### Question 4: Should Observe Be Public API?

**Context:** Stagehand's observe is internal (called by `act` tool). Should we expose it?

**Option A: Internal Only**
```typescript
// observe() only called by act tool
// Not exposed to agent
```

**Option B: Public Tool**
```typescript
// Agent can call observe directly
Agent: [calls observe("find all buttons")]
```

**Recommendation:** **Option A** (Internal Only)

**Reasoning:**
- Simpler mental model for agent
- Agent says WHAT to do, not HOW to find it
- Reduces tool count (less overwhelming)
- Can expose later if needed

---

### Question 5: How to Handle Visual Mode?

**Context:** Current HyperAgent has visual mode with screenshot + overlays. Should V2 support it?

**Recommendation:** **Keep visual mode as separate code path**

**Reasoning:**
- Visual mode is fundamentally different (needs overlays)
- Don't force tool-based architecture on visual mode
- Keep V2 focused on a11y mode
- Can refactor visual mode later if V2 proves successful

```typescript
export async function runAgentTask(ctx, taskState, params) {
  if (ctx.domConfig?.mode === 'visual') {
    // Use V1 architecture (optimized for visual)
    return runAgentTaskV1(ctx, taskState, params);
  } else {
    // Use V2 architecture (tool-based for a11y)
    return runAgentTaskV2(ctx, taskState, params);
  }
}
```

---

### Question 6: Should We Keep Page.ai() API?

**Context:** Current HyperAgent has `page.ai("click login")` convenience API.

**Recommendation:** **Yes, keep it but route to V2 internally**

**Reasoning:**
- Users like the simple API
- Internally, it calls the agent with tool-based architecture
- Best of both worlds: simple API + robust implementation

```typescript
// User code (unchanged)
await page.ai("click login");

// Internally (changed)
async ai(instruction: string) {
  return runAgentTaskV2(this.ctx, {
    task: instruction,
    startingPage: this.page,
    ...
  });
}
```

---

## Success Metrics

### Before Migration (Current V1)

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Token usage per task** | Baseline | Average tokens for 100 test tasks |
| **Success rate** | Baseline | % of tasks completed successfully |
| **Loop incidents** | Baseline | % of tasks that hit maxSteps |
| **Average steps per task** | Baseline | Average number of steps |

### After Migration (V2)

| Metric | Target | Success Criteria |
|--------|--------|------------------|
| **Token usage** | -50% | V2 uses 50% fewer tokens than V1 |
| **Success rate** | +10% | V2 completes 10% more tasks than V1 |
| **Loop incidents** | -80% | V2 has 80% fewer loop incidents |
| **Average steps** | -20% | V2 uses 20% fewer steps on average |
| **Time to complete** | Similar | V2 takes similar wall-clock time |

### Measurement Plan

**Week 1 (Before):**
1. Run 100 test tasks with V1
2. Record metrics
3. Identify problem tasks (loops, failures)

**Week 2-3 (Development):**
1. Implement V2
2. Run same 100 tasks with V2
3. Compare metrics

**Week 3 (Validation):**
1. If V2 meets targets → make it default
2. If V2 doesn't meet targets → iterate or rollback
3. Update documentation with results

---

## Timeline

### Week 1: Foundation
- **Days 1-2:** Implement observe function + tests
- **Days 3-4:** Create tool types + getDOM tool
- **Day 5:** Test observe standalone, validate approach

### Week 2: Core Implementation
- **Days 1-2:** Implement act, complete, scroll tools
- **Days 3-4:** Create agent-v2.ts with AI SDK integration
- **Day 5:** Add feature flag, test both architectures in parallel

### Week 3: Polish & Migration
- **Days 1-2:** Run benchmarks, compare metrics
- **Days 3-4:** Fix issues, optimize prompts
- **Day 5:** Make V2 default if metrics good, update docs

**Total:** 3 weeks from start to production-ready

---

## Risk Mitigation

### Risk 1: V2 Performs Worse Than V1

**Probability:** Low-Medium
**Impact:** High

**Mitigation:**
- Gradual migration with feature flag
- Comprehensive benchmarking before switching default
- Can rollback to V1 at any time
- Keep both implementations during transition

---

### Risk 2: Observe Function Not Accurate Enough

**Probability:** Medium
**Impact:** High

**Mitigation:**
- Test observe standalone first (Phase 1)
- Can iterate on observe prompts without touching agent loop
- Can use multiple LLM calls if needed (ensemble)
- Fall back to direct elementId if observe fails

---

### Risk 3: AI SDK Integration Issues

**Probability:** Low
**Impact:** Medium

**Mitigation:**
- AI SDK is well-documented and maintained
- Stagehand proves it works
- Can use our existing LLM client with adapter pattern
- Community support available

---

### Risk 4: Breaking Changes for Users

**Probability:** Medium
**Impact:** Medium

**Mitigation:**
- Feature flag allows gradual adoption
- Keep V1 for backwards compatibility
- Document migration guide
- Version bump (1.x → 2.x) signals breaking change

---

## Conclusion

HyperAgent's current architecture has fundamental issues causing infinite loops and poor task completion. Stagehand's tool-based approach with on-demand DOM fetching and natural language actions is proven to work better.

**Key Changes:**
1. ✅ Tool-based actions (agent says "click login" not `elementId: "0-1234"`)
2. ✅ On-demand DOM (fetch only when agent calls getDOM tool)
3. ✅ Observe function (separate "what to do" from "how to find element")
4. ✅ Simple prompt (30 lines vs 500+)
5. ✅ Natural conversation (tool results as messages, not JSON)
6. ✅ Hard maxSteps limit (prevent infinite loops)

**Timeline:** 3 weeks (gradual migration with feature flag)

**Success Criteria:**
- 50% fewer tokens
- 10% higher success rate
- 80% fewer loop incidents

**Risk:** Medium (major refactor but gradual migration reduces risk)

**Recommendation:** Proceed with gradual migration (Option A). Start with observe function (Phase 1), validate it works, then proceed with full implementation.
