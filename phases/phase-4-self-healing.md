# Phase 4: Self-Healing & Multiple Selector Strategies

## Executive Summary

**Goal:** Implement self-healing mechanisms to recover from element selection failures and improve success rate on dynamic sites.

**Impact:**
- 🎯 **Dynamic Sites:** 60-75% → 85-95% success rate (+20-30%)
- 🔄 **Retry Logic:** Automatic recovery from common failures
- 🎭 **Selector Strategies:** 4 fallback methods (XPath, CSS, Text, ARIA)
- ⏱️ **Added Latency:** +1-2s only on failures (worth it for +20% success)

---

## Why This Improvement?

### Problems with Current Implementation

#### **1. Single-Try, Single-Strategy**
```typescript
// Current: src/agent/actions/click-element.ts:26-29
const locator = getLocator(ctx, index);
if (!locator) {
  return { success: false, message: "Element not found" };
}

// If element not found → Immediate failure
// No retry, no alternative strategy, task fails
```

**Issues:**
- Element might exist but selector is stale
- CSS path might have changed since DOM extraction
- No attempt to find element by other means (text, ARIA, etc.)

#### **2. No Re-observation**
```
Flow:
1. Extract DOM at time T
2. LLM analyzes DOM
3. LLM returns action (2 seconds later)
4. Try to execute action
5. Page has changed! Element moved/removed
6. ❌ Failure

Problem: DOM state at step 4 might be different from step 1
```

#### **3. Dynamic Content Failures**
```
Common scenarios that fail:
- Lazy-loaded elements (appear after scroll)
- Animation-delayed elements (fade in after 1s)
- Modal dialogs (overlay entire page)
- Infinite scroll pages (content loads dynamically)
- SPA transitions (React/Vue re-renders)

Current approach: ❌ All fail immediately
Desired: ✅ Wait, re-check, retry with different strategy
```

#### **4. No Element Text Matching**
```typescript
// Current: Only uses pre-computed CSS path
const locator = ctx.page.locator(element.cssPath);

// If CSS path breaks, we have element text but don't use it:
element.text = "Submit Form"  // ← Not used as fallback!
```

---

## High-Level Concepts

### Concept: Self-Healing Architecture

```
Action Execution Attempt #1
    ↓
┌─────────────────────────────────────────┐
│ Try Primary Strategy (XPath)            │
│ - Use pre-computed XPath from DOM      │
│ - page.locator(`xpath=${xpath}`)       │
└─────────────────────────────────────────┘
    ↓
    ✅ Success? → Done!
    ❌ Failed?
    ↓
┌─────────────────────────────────────────┐
│ Strategy #2: CSS Selector               │
│ - Try CSS path as fallback             │
│ - page.locator(cssPath)                 │
└─────────────────────────────────────────┘
    ↓
    ✅ Success? → Done!
    ❌ Failed?
    ↓
┌─────────────────────────────────────────┐
│ Strategy #3: Re-observe DOM             │
│ - Page might have changed               │
│ - Extract fresh DOM state               │
│ - Find element by text/ARIA label       │
└─────────────────────────────────────────┘
    ↓
    ✅ Found? → Execute action
    ❌ Still not found?
    ↓
┌─────────────────────────────────────────┐
│ Strategy #4: Text-based Search          │
│ - page.getByText(element.name)         │
│ - Approximate match if exact fails      │
└─────────────────────────────────────────┘
    ↓
    ✅ Success? → Done!
    ❌ Failed? → Report failure after 4 attempts
```

### Re-observation Pattern (from Stagehand)

```
Stagehand's observe() + act() pattern:

observe("find submit button")
    ↓
Returns: elementId + method
    ↓
act(elementId, method)
    ↓
❌ Action fails
    ↓
observe("find submit button") ← Re-observe!
    ↓
Returns: NEW elementId (element might have moved)
    ↓
act(NEW elementId, method)
    ↓
✅ Success!
```

**Key Insight:** DOM might change between observation and action, so re-observe on failure.

---

## Detailed Implementation

### 1. Multi-Strategy Element Finder

#### **File: `src/utils/element-finder.ts`** (NEW)

```typescript
import { Page, Locator } from 'patchright';
import { EnhancedAXNode } from '@/context-providers/a11y-dom/types';

export type SelectorStrategy = 'xpath' | 'css' | 'text' | 'aria-label' | 'role';

export interface FindElementOptions {
  strategies?: SelectorStrategy[];
  timeout?: number;
  retries?: number;
}

export interface FindElementResult {
  locator: Locator | null;
  strategy: SelectorStrategy | null;
  attemptCount: number;
}

/**
 * Find element using multiple fallback strategies
 */
export async function findElementWithFallbacks(
  page: Page,
  element: EnhancedAXNode,
  options: FindElementOptions = {}
): Promise<FindElementResult> {
  const {
    strategies = ['xpath', 'css', 'text', 'aria-label', 'role'],
    timeout = 2000,
    retries = 1,
  } = options;

  let attemptCount = 0;

  for (let retry = 0; retry <= retries; retry++) {
    for (const strategy of strategies) {
      attemptCount++;

      try {
        const locator = await tryStrategy(page, element, strategy, timeout);

        if (locator && (await locator.count()) > 0) {
          console.log(`[ElementFinder] Found using ${strategy} (attempt ${attemptCount})`);
          return { locator, strategy, attemptCount };
        }
      } catch (error) {
        console.log(`[ElementFinder] Strategy ${strategy} failed:`, error.message);
      }
    }

    // Wait before retry
    if (retry < retries) {
      console.log(`[ElementFinder] Waiting 1s before retry ${retry + 1}...`);
      await page.waitForTimeout(1000);
    }
  }

  console.log(`[ElementFinder] All strategies failed after ${attemptCount} attempts`);
  return { locator: null, strategy: null, attemptCount };
}

/**
 * Try a single selector strategy
 */
async function tryStrategy(
  page: Page,
  element: EnhancedAXNode,
  strategy: SelectorStrategy,
  timeout: number
): Promise<Locator | null> {
  switch (strategy) {
    case 'xpath':
      return tryXPath(page, element, timeout);

    case 'css':
      return tryCSSPath(page, element, timeout);

    case 'text':
      return tryTextMatch(page, element, timeout);

    case 'aria-label':
      return tryAriaLabel(page, element, timeout);

    case 'role':
      return tryRole(page, element, timeout);

    default:
      return null;
  }
}

/**
 * Strategy 1: XPath (most precise)
 */
async function tryXPath(
  page: Page,
  element: EnhancedAXNode,
  timeout: number
): Promise<Locator | null> {
  if (!element.xpath) {
    return null;
  }

  const locator = page.locator(`xpath=${element.xpath}`);

  try {
    await locator.waitFor({ state: 'attached', timeout });
    return locator;
  } catch {
    return null;
  }
}

/**
 * Strategy 2: CSS Path
 */
async function tryCSSPath(
  page: Page,
  element: EnhancedAXNode,
  timeout: number
): Promise<Locator | null> {
  // Generate CSS path from XPath or element attributes
  const cssPath = generateCSSPath(element);

  if (!cssPath) {
    return null;
  }

  const locator = page.locator(cssPath);

  try {
    await locator.waitFor({ state: 'attached', timeout });
    return locator;
  } catch {
    return null;
  }
}

/**
 * Strategy 3: Text match (fuzzy)
 */
async function tryTextMatch(
  page: Page,
  element: EnhancedAXNode,
  timeout: number
): Promise<Locator | null> {
  if (!element.name) {
    return null;
  }

  // Try exact match first
  let locator = page.getByText(element.name, { exact: true });

  if ((await locator.count()) === 0) {
    // Try partial match
    locator = page.getByText(element.name, { exact: false });
  }

  if ((await locator.count()) === 0) {
    return null;
  }

  try {
    await locator.first().waitFor({ state: 'attached', timeout });
    return locator.first();
  } catch {
    return null;
  }
}

/**
 * Strategy 4: ARIA label
 */
async function tryAriaLabel(
  page: Page,
  element: EnhancedAXNode,
  timeout: number
): Promise<Locator | null> {
  if (!element.name) {
    return null;
  }

  const locator = page.getByLabel(element.name, { exact: false });

  if ((await locator.count()) === 0) {
    return null;
  }

  try {
    await locator.first().waitFor({ state: 'attached', timeout });
    return locator.first();
  } catch {
    return null;
  }
}

/**
 * Strategy 5: Role + Name (Playwright getByRole)
 */
async function tryRole(
  page: Page,
  element: EnhancedAXNode,
  timeout: number
): Promise<Locator | null> {
  if (!element.role) {
    return null;
  }

  // Map accessibility roles to Playwright roles
  const playwrightRole = mapRole(element.role);

  if (!playwrightRole) {
    return null;
  }

  const locator = element.name
    ? page.getByRole(playwrightRole, { name: element.name })
    : page.getByRole(playwrightRole);

  if ((await locator.count()) === 0) {
    return null;
  }

  try {
    await locator.first().waitFor({ state: 'attached', timeout });
    return locator.first();
  } catch {
    return null;
  }
}

/**
 * Map accessibility role to Playwright role
 */
function mapRole(axRole: string): string | null {
  const roleMap: Record<string, string> = {
    'button': 'button',
    'link': 'link',
    'textbox': 'textbox',
    'searchbox': 'searchbox',
    'checkbox': 'checkbox',
    'radio': 'radio',
    'combobox': 'combobox',
    'listbox': 'listbox',
    'menuitem': 'menuitem',
    'tab': 'tab',
    'heading': 'heading',
    'img': 'img',
    'a': 'link',
    'input': 'textbox',
    'select': 'combobox',
  };

  return roleMap[axRole.toLowerCase()] || null;
}

/**
 * Generate CSS path from element attributes
 */
function generateCSSPath(element: EnhancedAXNode): string | null {
  // Try ID first (most specific)
  if (element.properties) {
    const idProp = element.properties.find(p => p.name === 'id');
    if (idProp && idProp.value) {
      return `#${idProp.value}`;
    }
  }

  // Try tag name + attributes
  let selector = element.tagName || '';

  if (element.properties) {
    const classProp = element.properties.find(p => p.name === 'class');
    if (classProp && classProp.value) {
      const classes = classProp.value.split(' ').filter(Boolean);
      selector += classes.map(c => `.${c}`).join('');
    }
  }

  return selector || null;
}
```

---

### 2. Re-observation Mechanism

#### **File: `src/agent/tools/self-healing.ts`** (NEW)

```typescript
import { Page } from 'patchright';
import { DOMState, getDom } from '@/context-providers/dom';
import { EnhancedAXNode } from '@/context-providers/a11y-dom/types';
import { findElementWithFallbacks } from '@/utils/element-finder';

export interface ReobserveResult {
  success: boolean;
  newElement?: EnhancedAXNode;
  domState?: DOMState;
}

/**
 * Re-observe the page and try to find element by text/name
 */
export async function reobserveAndFind(
  page: Page,
  originalElement: EnhancedAXNode,
  domMode: 'visual' | 'a11y' | 'hybrid'
): Promise<ReobserveResult> {
  console.log('[SelfHealing] Re-observing page...');

  // Wait for DOM to settle
  await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);

  // Extract fresh DOM
  const domState = await getDom(page, domMode);

  if (!domState) {
    return { success: false };
  }

  // Try to find element with same name/text
  const newElement = findElementByName(
    domState.elements,
    originalElement.name || ''
  );

  if (newElement) {
    console.log('[SelfHealing] Found element after re-observation');
    return { success: true, newElement, domState };
  }

  // Try to find by role + partial name
  const partialMatch = findElementByRoleAndPartialName(
    domState.elements,
    originalElement.role,
    originalElement.name || ''
  );

  if (partialMatch) {
    console.log('[SelfHealing] Found partial match after re-observation');
    return { success: true, newElement: partialMatch, domState };
  }

  return { success: false, domState };
}

/**
 * Find element by exact name match
 */
function findElementByName(
  elements: Map<string, EnhancedAXNode>,
  name: string
): EnhancedAXNode | undefined {
  if (!name) return undefined;

  const normalized = name.toLowerCase().trim();

  for (const element of elements.values()) {
    if (element.name?.toLowerCase().trim() === normalized) {
      return element;
    }
  }

  return undefined;
}

/**
 * Find element by role + partial name match
 */
function findElementByRoleAndPartialName(
  elements: Map<string, EnhancedAXNode>,
  role: string,
  name: string
): EnhancedAXNode | undefined {
  if (!role || !name) return undefined;

  const normalizedName = name.toLowerCase().trim();
  const matchingRole = Array.from(elements.values()).filter(
    el => el.role === role
  );

  // Find element with most similar name
  let bestMatch: EnhancedAXNode | undefined;
  let bestScore = 0;

  for (const element of matchingRole) {
    if (!element.name) continue;

    const elementName = element.name.toLowerCase().trim();
    const score = stringSimilarity(normalizedName, elementName);

    if (score > bestScore && score > 0.7) {
      bestScore = score;
      bestMatch = element;
    }
  }

  return bestMatch;
}

/**
 * Calculate string similarity (simple Levenshtein-based)
 */
function stringSimilarity(str1: string, str2: string): number {
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;

  if (longer.length === 0) return 1.0;

  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function levenshteinDistance(str1: string, str2: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[str2.length][str1.length];
}
```

---

### 3. Self-Healing Action Runner

#### **File: `src/agent/tools/agent.ts`** (MODIFY)

```typescript
import { findElementWithFallbacks } from '@/utils/element-finder';
import { reobserveAndFind } from './self-healing';

/**
 * Run action with self-healing retry logic
 */
async function runActionWithSelfHealing(
  action: ActionType,
  domState: DOMState,
  page: Page,
  ctx: AgentCtx,
  maxRetries: number = 2
): Promise<ActionOutput> {
  let lastError: Error | null = null;
  let currentDomState = domState;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`[SelfHealing] Action attempt ${attempt + 1}/${maxRetries}`);

      // Try to execute action
      const result = await runActionAttempt(
        action,
        currentDomState,
        page,
        ctx
      );

      if (result.success) {
        if (attempt > 0) {
          console.log(`[SelfHealing] Succeeded after ${attempt + 1} attempts`);
        }
        return result;
      }

      lastError = new Error(result.message);

      // Action failed, try self-healing strategies
      if (attempt < maxRetries - 1) {
        console.log(`[SelfHealing] Attempt ${attempt + 1} failed, trying recovery...`);

        // Wait a bit for page to settle
        await page.waitForTimeout(1000);

        // Re-observe the page
        const element = currentDomState.elements.get(action.params.elementId);
        if (element) {
          const reobserved = await reobserveAndFind(
            page,
            element,
            ctx.domMode || 'a11y'
          );

          if (reobserved.success && reobserved.newElement && reobserved.domState) {
            console.log('[SelfHealing] Found element after re-observation');
            // Update action with new elementId
            action.params.elementId = reobserved.newElement.backendDOMNodeId;
            currentDomState = reobserved.domState;
            continue; // Retry with new element
          }
        }
      }
    } catch (error) {
      lastError = error as Error;
      console.error(`[SelfHealing] Attempt ${attempt + 1} error:`, error);

      if (attempt < maxRetries - 1) {
        await page.waitForTimeout(1000);
      }
    }
  }

  return {
    success: false,
    message: `Action failed after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`,
  };
}

/**
 * Single action execution attempt with multi-strategy element finding
 */
async function runActionAttempt(
  action: ActionType,
  domState: DOMState,
  page: Page,
  ctx: AgentCtx
): Promise<ActionOutput> {
  const actionCtx: ActionContext = {
    domState,
    page,
    tokenLimit: ctx.tokenLimit,
    llm: ctx.llm,
    debugDir: ctx.debugDir,
    mcpClient: ctx.mcpClient || undefined,
    variables: Object.values(ctx.variables),
    actionConfig: ctx.actionConfig,
  };

  // For element-based actions, try multi-strategy finder
  if (action.params.elementId) {
    const element = domState.elements.get(action.params.elementId);

    if (element) {
      // Try multiple selector strategies
      const findResult = await findElementWithFallbacks(page, element, {
        strategies: ['xpath', 'css', 'text', 'aria-label', 'role'],
        timeout: 2000,
        retries: 1,
      });

      if (!findResult.locator) {
        return {
          success: false,
          message: `Element ${action.params.elementId} not found with any strategy`,
        };
      }

      console.log(`[SelfHealing] Using ${findResult.strategy} strategy`);

      // Execute action with found locator
      return await executeActionWithLocator(
        action,
        findResult.locator,
        actionCtx
      );
    }
  }

  // Fallback to normal execution for non-element actions
  const actionHandler = getActionHandler(ctx.actions, action.type);
  return await actionHandler(actionCtx, action.params);
}

/**
 * Execute action with a specific locator
 */
async function executeActionWithLocator(
  action: ActionType,
  locator: Locator,
  ctx: ActionContext
): Promise<ActionOutput> {
  try {
    switch (action.type) {
      case 'clickElement':
        await locator.scrollIntoViewIfNeeded({ timeout: 2500 });
        await locator.waitFor({ state: 'visible', timeout: 2500 });
        await locator.click({ force: true });
        return { success: true, message: 'Clicked element' };

      case 'inputText':
        await locator.fill(action.params.text, { timeout: 5000 });
        return { success: true, message: `Inputted text: ${action.params.text}` };

      case 'selectOption':
        await locator.selectOption(action.params.option, { timeout: 5000 });
        return { success: true, message: `Selected: ${action.params.option}` };

      default:
        return { success: false, message: 'Unsupported action type for locator execution' };
    }
  } catch (error) {
    return { success: false, message: `Action execution failed: ${error.message}` };
  }
}

// UPDATE runAgentTask to use self-healing
export const runAgentTask = async (
  ctx: AgentCtx,
  taskState: TaskState,
  params?: TaskParams
): Promise<TaskOutput> => {
  // ... existing code

  // REPLACE:
  // const actionOutput = await runAction(action, domState, page, ctx);

  // WITH:
  const actionOutput = await runActionWithSelfHealing(
    action as ActionType,
    domState,
    page,
    ctx,
    ctx.selfHealingRetries || 2
  );

  // ... rest of code
};
```

---

### 4. Configuration

#### **File: `src/types/config.ts`** (MODIFY)

```typescript
export interface HyperAgentConfig<T extends BrowserProviders = "Local"> {
  // ... existing config

  // ADD:
  selfHealing?: {
    enabled?: boolean;
    maxRetries?: number; // Default: 2
    strategies?: Array<'xpath' | 'css' | 'text' | 'aria-label' | 'role'>;
    reobserveOnFailure?: boolean; // Default: true
  };
}
```

#### **File: `src/agent/index.ts`** (MODIFY)

```typescript
export class HyperAgent<T extends BrowserProviders = "Local"> {
  private selfHealingConfig?: HyperAgentConfig['selfHealing'];

  constructor(params: HyperAgentConfig<T> = {}) {
    // ... existing constructor

    // ADD:
    this.selfHealingConfig = {
      enabled: params.selfHealing?.enabled ?? true,
      maxRetries: params.selfHealing?.maxRetries ?? 2,
      strategies: params.selfHealing?.strategies ?? ['xpath', 'css', 'text', 'aria-label', 'role'],
      reobserveOnFailure: params.selfHealing?.reobserveOnFailure ?? true,
    };
  }
}
```

---

## Usage Examples

### Example 1: Default Self-Healing
```typescript
const agent = new HyperAgent({
  selfHealing: {
    enabled: true, // Default
  },
});

const page = await agent.getCurrentPage();
await page.goto('https://dynamic-spa.com');

// Page has animations, lazy loading, etc.
await page.ai('click the submit button');
// Will try up to 2 times, using 5 different selector strategies
// Total attempts: 2 retries × 5 strategies = up to 10 attempts
```

### Example 2: Aggressive Retry
```typescript
const agent = new HyperAgent({
  selfHealing: {
    enabled: true,
    maxRetries: 3, // Try harder
    strategies: ['xpath', 'css', 'text', 'aria-label', 'role'],
  },
});

// For very flaky pages
await page.ai('fill the form');
```

### Example 3: Disable Self-Healing
```typescript
const agent = new HyperAgent({
  selfHealing: {
    enabled: false, // Fast fail for testing
  },
});

// Fails immediately if element not found
```

---

## Testing Strategy

### Test 1: Dynamic Content
```typescript
async function testDynamicContent() {
  const page = await agent.getCurrentPage();
  await page.goto('https://example.com');

  // Trigger lazy load
  await page.evaluate(() => {
    setTimeout(() => {
      const button = document.createElement('button');
      button.textContent = 'Load More';
      document.body.appendChild(button);
    }, 2000); // Appears after 2 seconds
  });

  // Should wait and find it
  const result = await page.ai('click Load More button');
  expect(result.status).toBe('completed');
}
```

### Test 2: Element Moved
```typescript
async function testElementMoved() {
  const page = await agent.getCurrentPage();
  await page.goto('https://example.com');

  // Move element after DOM extraction
  setTimeout(async () => {
    await page.evaluate(() => {
      const button = document.querySelector('button');
      document.body.removeChild(button!);
      document.body.appendChild(button!); // Move to end
    });
  }, 1000);

  // Should re-observe and find new location
  const result = await page.ai('click the button');
  expect(result.status).toBe('completed');
}
```

### Test 3: Success Rate on Dynamic Sites
```typescript
const dynamicSites = [
  'https://react-app.com',
  'https://vue-app.com',
  'https://angular-app.com',
];

let successCount = 0;

for (const site of dynamicSites) {
  const result = await page.ai('click main button');
  if (result.status === 'completed') successCount++;
}

const successRate = successCount / dynamicSites.length;
console.log('Success rate:', successRate);
// Expected: 85-95% with self-healing (vs 60-75% without)
```

---

## Performance Impact

### Latency Analysis

| Scenario | No Self-Healing | With Self-Healing | Delta |
|----------|----------------|-------------------|-------|
| **Success first try** | 800ms | 850ms | +50ms (overhead) |
| **Success second try** | N/A (fails) | 2,300ms | Worth it! |
| **Success third try** | N/A (fails) | 3,800ms | Worth it! |
| **Total failure** | 800ms | 4,000ms | +3,200ms (but tried harder) |

**Key Insight:** Small overhead on success (6%), huge win on recovery.

---

## Success Criteria

### Must Have
- ✅ 85%+ success rate on dynamic sites (up from 60-75%)
- ✅ <100ms overhead on successful first attempt
- ✅ Maximum 3 retries (prevent infinite loops)
- ✅ Clear logging of retry attempts

### Should Have
- ✅ Text-based fallback finds elements 70%+ of time
- ✅ Re-observation succeeds 60%+ when element moved
- ✅ Configurable retry strategies
- ✅ Performance metrics per strategy

### Nice to Have
- ✅ ML-based selector optimization (learn which strategies work)
- ✅ Automatic strategy ordering based on success rate
- ✅ Smart wait times (detect animation duration)
- ✅ Visual diff to detect page changes

---

## Code Quality Standards

### 1. Error Handling
```typescript
// Never throw, always return result
try {
  await action();
} catch (error) {
  return { success: false, message: error.message };
}
```

### 2. Logging
```typescript
// Clear logs at each step
console.log('[SelfHealing] Attempt 1/2');
console.log('[SelfHealing] Using xpath strategy');
console.log('[SelfHealing] Success after 2 attempts');
```

### 3. Timeouts
```typescript
// Always set timeouts to prevent hanging
await locator.waitFor({ state: 'visible', timeout: 2500 });
```

### 4. Testing
```typescript
// Unit tests for each strategy
describe('findElementWithFallbacks', () => {
  it('should try xpath first', () => { ... });
  it('should fallback to text search', () => { ... });
  it('should give up after max retries', () => { ... });
});
```

---

## References

- **Stagehand Self-Healing:** `/Users/devin/projects/stagehand/stagehand/lib/handlers/actHandler.ts:103`
- **Playwright Locators:** https://playwright.dev/docs/locators
- **Element Selection Strategies:** https://playwright.dev/docs/selectors
