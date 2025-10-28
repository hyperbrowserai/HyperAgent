# Phase 2: Dual-Layer Caching System

## Executive Summary

**Goal:** Implement two-tier caching (Action Cache + LLM Cache) for 20-30x speed improvement on repeated tasks.

**Impact:**
- ⚡ **Cached Actions:** 2,000ms → 80ms (96% faster, 25x speed)
- 💰 **Cost Savings:** $0 for cached actions (no LLM calls)
- 🔄 **Repeat Tasks:** Nearly instant execution
- 📊 **Cache Hit Rate:** 70%+ for typical usage

---

## Why This Improvement?

### Problem with Current Implementation

#### **1. Every Action Requires LLM Call**
```typescript
// Current: src/agent/tools/agent.ts:220-231
const structuredResult = await retry({
  func: () =>
    ctx.llm.invokeStructured(
      {
        schema: AgentOutputFn(actionSchema),
        options: { temperature: 0 },
      },
      msgs
    ),
});

// EVERY single action:
// 1. Calls LLM (200-800ms)
// 2. Costs tokens ($0.01-0.05)
// 3. No memory of previous actions
```

**Cost Example:**
```
Scenario: User runs "click login button" 100 times during testing

Current approach:
- Call 1: 2,000ms, $0.02
- Call 2: 2,000ms, $0.02  ← Same task, same cost!
- Call 3: 2,000ms, $0.02  ← Same task, same cost!
- ...
- Call 100: 2,000ms, $0.02

Total: 200 seconds, $2.00

With caching:
- Call 1: 2,000ms, $0.02 (cache miss, normal LLM call)
- Call 2: 80ms, $0.00    ← Cache hit!
- Call 3: 80ms, $0.00    ← Cache hit!
- ...
- Call 100: 80ms, $0.00

Total: 10 seconds, $0.02 (99% cost reduction!)
```

#### **2. Same DOM → Same LLM Response (Wasteful)**
```typescript
// User does: page.ai("click submit button")
// Step 1: Extract DOM, call LLM → "click element abc123"

// User refreshes page and does SAME THING
// Step 2: Extract DOM (identical), call LLM again → Same response!
// We paid for LLM twice for identical input/output
```

#### **3. Testing/Development Slowness**
```
Developer workflow:
1. Write code: page.ai("fill login form")
2. Run test → 3 seconds (LLM call)
3. Code crashes, fix bug
4. Run test again → 3 seconds (same LLM call!)
5. Another bug, fix
6. Run test again → 3 seconds (same LLM call!)

Without cache: 10 test runs = 30 seconds
With cache: 10 test runs = 3 seconds (first) + 9×0.08s = 3.7 seconds
```

---

## High-Level Concepts

### Concept 5: Caching Architecture

```
User Task: "Click the login button"
URL: https://example.com/login
    ↓
┌─────────────────────────────────────────────┐
│  Layer 1: Action Cache                      │
│  Key: instruction + URL                     │
│  Value: elementId + xpath + method          │
│                                             │
│  Check: "click login button" @ /login      │
│  Found: elementId="abc123", xpath="...",    │
│         method="click"                      │
└─────────────────────────────────────────────┘
    ↓ CACHE HIT → Skip LLM entirely!
    ↓
┌─────────────────────────────────────────────┐
│  Execute Cached Action                      │
│  1. Verify element exists at xpath         │
│  2. If yes → click immediately (80ms)      │
│  3. If no → Fall through to LLM            │
└─────────────────────────────────────────────┘
    ↓
✅ Done in 80ms!


CACHE MISS Path:
    ↓
┌─────────────────────────────────────────────┐
│  Layer 2: LLM Cache                         │
│  Key: hash(system prompt + DOM + task)     │
│  Value: LLM response                        │
│                                             │
│  Check: hash(messages) = "7a3f2b..."       │
│  Found: { actions: [...] }                  │
└─────────────────────────────────────────────┘
    ↓ LLM CACHE HIT → Skip LLM call
    ↓
✅ Done in 150ms (no LLM call, just DOM extraction)


LLM CACHE MISS Path:
    ↓
┌─────────────────────────────────────────────┐
│  Call LLM (Slow Path)                       │
│  1. Extract DOM (500ms)                     │
│  2. Call LLM (800ms)                        │
│  3. Store in LLM Cache                      │
│  4. Store in Action Cache                   │
│  5. Execute action                          │
└─────────────────────────────────────────────┘
    ↓
✅ Done in 2,000ms (but cached for next time)
```

### Two-Tier Strategy

**Layer 1: Action Cache** (Fastest)
- Caches: `(instruction + URL)` → `(elementId + xpath + method)`
- Hits when: Exact same instruction on same URL
- Speed: ~80ms (just DOM verification + click)
- Skip: DOM extraction, LLM call, action planning

**Layer 2: LLM Cache** (Fast)
- Caches: `hash(messages)` → `LLM response`
- Hits when: Same DOM state, same task (even different URL)
- Speed: ~150ms (DOM extraction only, no LLM)
- Skip: LLM call only

**No Cache** (Slow)
- Full pipeline: DOM + LLM + Action
- Speed: ~2,000ms
- Use: First time seeing task

---

## Detailed Implementation

### 1. Action Cache

#### **File: `src/cache/action-cache.ts`** (NEW)

```typescript
import { LRUCache } from 'lru-cache';
import crypto from 'crypto';

export interface CachedAction {
  instruction: string;
  url: string;
  elementId: string;
  xpath: string;
  method: 'click' | 'input' | 'select';
  timestamp: number;
}

export interface ActionCacheStats {
  size: number;
  hits: number;
  misses: number;
  hitRate: number;
}

export class ActionCache {
  private cache: LRUCache<string, CachedAction>;
  private hits = 0;
  private misses = 0;

  constructor(options: {
    maxSize?: number;
    ttl?: number; // milliseconds
  } = {}) {
    this.cache = new LRUCache({
      max: options.maxSize || 1000,
      ttl: options.ttl || 1000 * 60 * 60 * 24, // 24 hours default
    });
  }

  /**
   * Normalize URL to remove variations that shouldn't affect caching
   * - Remove query parameters
   * - Remove hash fragments
   * - Lowercase host
   */
  private normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      // Keep only origin + pathname
      return parsed.origin.toLowerCase() + parsed.pathname;
    } catch {
      return url; // If URL parsing fails, use as-is
    }
  }

  /**
   * Normalize instruction to make cache more flexible
   * - Lowercase
   * - Trim whitespace
   * - Remove common variations ("click the" vs "click")
   */
  private normalizeInstruction(instruction: string): string {
    return instruction
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ') // Normalize whitespace
      .replace(/^(click|press|tap)\s+(the\s+)?/, 'click ') // Normalize click variations
      .replace(/^(fill|enter|type|input)\s+(in\s+)?(the\s+)?/, 'input ') // Normalize input variations
      .replace(/^(select|choose|pick)\s+(the\s+)?/, 'select '); // Normalize select variations
  }

  /**
   * Generate cache key from instruction + URL
   */
  private getCacheKey(instruction: string, url: string): string {
    const normalizedUrl = this.normalizeUrl(url);
    const normalizedInstruction = this.normalizeInstruction(instruction);

    // Use hash for shorter keys
    const combined = `${normalizedInstruction}::${normalizedUrl}`;
    return crypto.createHash('sha256').update(combined).digest('hex').substring(0, 16);
  }

  /**
   * Try to get cached action
   */
  get(instruction: string, url: string): CachedAction | undefined {
    const key = this.getCacheKey(instruction, url);
    const cached = this.cache.get(key);

    if (cached) {
      this.hits++;
      return cached;
    }

    this.misses++;
    return undefined;
  }

  /**
   * Store successful action in cache
   */
  set(
    instruction: string,
    url: string,
    elementId: string,
    xpath: string,
    method: 'click' | 'input' | 'select'
  ): void {
    const key = this.getCacheKey(instruction, url);

    this.cache.set(key, {
      instruction,
      url,
      elementId,
      xpath,
      method,
      timestamp: Date.now(),
    });
  }

  /**
   * Check if element still exists at cached xpath
   */
  async verifyCached(
    cached: CachedAction,
    page: any // Playwright Page
  ): Promise<boolean> {
    try {
      const locator = page.locator(`xpath=${cached.xpath}`);
      const count = await locator.count();
      return count > 0;
    } catch {
      return false;
    }
  }

  /**
   * Clear all cached actions
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Get cache statistics
   */
  getStats(): ActionCacheStats {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  /**
   * Export cache for persistence
   */
  export(): CachedAction[] {
    const entries: CachedAction[] = [];
    this.cache.forEach((value) => {
      entries.push(value);
    });
    return entries;
  }

  /**
   * Import cache from persistence
   */
  import(entries: CachedAction[]): void {
    for (const entry of entries) {
      this.set(
        entry.instruction,
        entry.url,
        entry.elementId,
        entry.xpath,
        entry.method
      );
    }
  }
}
```

**Why This Design:**

1. **LRU Eviction:** Keeps most-used actions, discards old ones
2. **TTL:** Actions expire after 24 hours (pages change)
3. **Normalized Keys:** "Click the button" = "click button" (flexible)
4. **Verification:** Checks if cached xpath still valid before using
5. **Statistics:** Track hit rate for debugging

---

### 2. LLM Cache

#### **File: `src/cache/llm-cache.ts`** (NEW)

```typescript
import { LRUCache } from 'lru-cache';
import crypto from 'crypto';
import { HyperAgentMessage } from '@/llm/types';

export interface CachedLLMResponse {
  promptHash: string;
  response: any;
  timestamp: number;
  model: string;
}

export interface LLMCacheStats {
  size: number;
  hits: number;
  misses: number;
  hitRate: number;
  tokensSaved: number;
}

export class LLMCache {
  private cache: LRUCache<string, CachedLLMResponse>;
  private hits = 0;
  private misses = 0;
  private tokensSaved = 0;

  constructor(options: {
    maxSize?: number;
    ttl?: number;
  } = {}) {
    this.cache = new LRUCache({
      max: options.maxSize || 500,
      ttl: options.ttl || 1000 * 60 * 60, // 1 hour default (shorter than action cache)
    });
  }

  /**
   * Hash the full conversation messages
   * Needs to be deterministic for same inputs
   */
  private hashMessages(messages: HyperAgentMessage[]): string {
    // Stringify messages, but exclude any non-deterministic fields
    const normalized = messages.map(msg => ({
      role: msg.role,
      content: this.normalizeContent(msg.content),
    }));

    const stringified = JSON.stringify(normalized);
    return crypto.createHash('sha256').update(stringified).digest('hex');
  }

  /**
   * Normalize content to handle image URLs consistently
   */
  private normalizeContent(content: any): any {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content.map(part => {
        if (part.type === 'image') {
          // Don't include full base64 in hash (too large)
          // Hash the image data instead
          const imageHash = crypto
            .createHash('sha256')
            .update(part.url || '')
            .digest('hex')
            .substring(0, 16);
          return { type: 'image', hash: imageHash };
        }
        return part;
      });
    }

    return content;
  }

  /**
   * Try to get cached LLM response
   */
  get(messages: HyperAgentMessage[], estimatedTokens: number = 0): any | undefined {
    const hash = this.hashMessages(messages);
    const cached = this.cache.get(hash);

    if (cached) {
      this.hits++;
      this.tokensSaved += estimatedTokens;
      return cached.response;
    }

    this.misses++;
    return undefined;
  }

  /**
   * Store LLM response in cache
   */
  set(
    messages: HyperAgentMessage[],
    response: any,
    model: string = 'unknown'
  ): void {
    const hash = this.hashMessages(messages);

    this.cache.set(hash, {
      promptHash: hash,
      response,
      timestamp: Date.now(),
      model,
    });
  }

  /**
   * Clear all cached responses
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    this.tokensSaved = 0;
  }

  /**
   * Get cache statistics
   */
  getStats(): LLMCacheStats {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      tokensSaved: this.tokensSaved,
    };
  }

  /**
   * Export cache for persistence
   */
  export(): CachedLLMResponse[] {
    const entries: CachedLLMResponse[] = [];
    this.cache.forEach((value) => {
      entries.push(value);
    });
    return entries;
  }

  /**
   * Import cache from persistence
   */
  import(entries: CachedLLMResponse[]): void {
    for (const entry of entries) {
      this.cache.set(entry.promptHash, entry);
    }
  }
}
```

**Why This Design:**

1. **Content-Addressed:** Same messages = same hash = cache hit
2. **Image Handling:** Hashes images instead of storing full base64
3. **Shorter TTL:** 1 hour (LLM responses less stable than actions)
4. **Token Tracking:** Estimates tokens saved for ROI metrics
5. **Model Tracking:** Different models might give different responses

---

### 3. Integrate Caches into HyperAgent

#### **File: `src/types/config.ts`** (MODIFY)

```typescript
export interface HyperAgentConfig<T extends BrowserProviders = "Local"> {
  // ... existing config

  // ADD:
  cache?: {
    enabled: boolean;
    actionCache?: {
      enabled?: boolean;
      maxSize?: number;
      ttl?: number; // milliseconds
    };
    llmCache?: {
      enabled?: boolean;
      maxSize?: number;
      ttl?: number;
    };
    persistence?: {
      enabled?: boolean;
      path?: string; // File path to save/load cache
    };
  };
}
```

#### **File: `src/agent/index.ts`** (MODIFY)

```typescript
import { ActionCache } from '@/cache/action-cache';
import { LLMCache } from '@/cache/llm-cache';
import fs from 'fs';
import path from 'path';

export class HyperAgent<T extends BrowserProviders = "Local"> {
  // ADD:
  private actionCache?: ActionCache;
  private llmCache?: LLMCache;
  private cacheConfig?: HyperAgentConfig['cache'];

  constructor(params: HyperAgentConfig<T> = {}) {
    // ... existing constructor

    // ADD: Initialize caches
    if (params.cache?.enabled) {
      this.cacheConfig = params.cache;

      if (params.cache.actionCache?.enabled !== false) {
        this.actionCache = new ActionCache({
          maxSize: params.cache.actionCache?.maxSize || 1000,
          ttl: params.cache.actionCache?.ttl || 1000 * 60 * 60 * 24,
        });
      }

      if (params.cache.llmCache?.enabled !== false) {
        this.llmCache = new LLMCache({
          maxSize: params.cache.llmCache?.maxSize || 500,
          ttl: params.cache.llmCache?.ttl || 1000 * 60 * 60,
        });
      }

      // Load persisted cache if enabled
      if (params.cache.persistence?.enabled) {
        this.loadCache();
      }
    }
  }

  /**
   * Clear all caches
   */
  public clearCache(): void {
    this.actionCache?.clear();
    this.llmCache?.clear();
  }

  /**
   * Get cache statistics
   */
  public getCacheStats(): {
    actionCache: ReturnType<ActionCache['getStats']>;
    llmCache: ReturnType<LLMCache['getStats']>;
  } | null {
    if (!this.actionCache || !this.llmCache) {
      return null;
    }

    return {
      actionCache: this.actionCache.getStats(),
      llmCache: this.llmCache.getStats(),
    };
  }

  /**
   * Save cache to disk
   */
  private saveCache(): void {
    if (!this.cacheConfig?.persistence?.enabled) return;

    const cachePath = this.cacheConfig.persistence.path || './.hyperagent-cache';

    const data = {
      actionCache: this.actionCache?.export() || [],
      llmCache: this.llmCache?.export() || [],
      timestamp: Date.now(),
    };

    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('Failed to save cache:', error);
    }
  }

  /**
   * Load cache from disk
   */
  private loadCache(): void {
    if (!this.cacheConfig?.persistence?.enabled) return;

    const cachePath = this.cacheConfig.persistence.path || './.hyperagent-cache';

    try {
      if (fs.existsSync(cachePath)) {
        const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));

        this.actionCache?.import(data.actionCache || []);
        this.llmCache?.import(data.llmCache || []);

        console.log('Cache loaded from disk');
      }
    } catch (error) {
      console.error('Failed to load cache:', error);
    }
  }

  /**
   * Close agent and save cache
   */
  public async closeAgent(): Promise<void> {
    // Save cache before closing
    if (this.cacheConfig?.persistence?.enabled) {
      this.saveCache();
    }

    // ... existing cleanup code
  }
}
```

---

### 4. Integrate Caches into Task Loop

#### **File: `src/agent/tools/agent.ts`** (MODIFY)

```typescript
import { ActionCache, CachedAction } from '@/cache/action-cache';
import { LLMCache } from '@/cache/llm-cache';

export interface AgentCtx {
  // ... existing fields
  actionCache?: ActionCache;  // ADD
  llmCache?: LLMCache;        // ADD
}

export const runAgentTask = async (
  ctx: AgentCtx,
  taskState: TaskState,
  params?: TaskParams
): Promise<TaskOutput> => {
  // ... existing setup

  const page = taskState.startingPage;
  let currStep = 0;

  while (true) {
    // ... status checks

    // ===== LAYER 1: ACTION CACHE =====
    // Try action cache first (fastest path)
    if (ctx.actionCache) {
      const cached = ctx.actionCache.get(taskState.task, page.url());

      if (cached) {
        console.log('[ActionCache] Cache hit for:', taskState.task);

        // Verify element still exists
        const isValid = await ctx.actionCache.verifyCached(cached, page);

        if (isValid) {
          // Execute cached action directly
          const success = await executeCachedAction(cached, page);

          if (success) {
            console.log('[ActionCache] Executed in ~80ms');
            taskState.status = TaskStatus.COMPLETED;

            return {
              status: TaskStatus.COMPLETED,
              output: '',
              steps: [{
                idx: 0,
                agentOutput: {
                  reasoning: 'Used cached action',
                  actions: [{ type: cached.method, params: {} }],
                },
                actionOutputs: [{ success: true, message: 'Cache hit' }],
              }],
            };
          }
        }

        console.log('[ActionCache] Cache invalid, falling through to LLM');
      }
    }

    // ===== LAYER 2: DOM EXTRACTION =====
    // Extract DOM (needed for both LLM cache and normal flow)
    let domState: DOMState | null = null;
    try {
      domState = await retry({
        func: async () => {
          const mode = ctx.domMode || 'a11y';
          const s = await getDom(page, mode);
          if (!s) throw new Error("no dom state");
          return s;
        },
        params: { retryCount: 3 },
      });
    } catch (error) {
      taskState.status = TaskStatus.FAILED;
      taskState.error = "Failed to retrieve DOM state";
      break;
    }

    if (!domState) {
      taskState.status = TaskStatus.FAILED;
      taskState.error = "Failed to retrieve DOM state";
      break;
    }

    // Build messages for LLM
    const msgs = await buildAgentStepMessages(
      baseMsgs,
      taskState.steps,
      taskState.task,
      page,
      domState,
      screenshot,
      Object.values(ctx.variables)
    );

    // ===== LAYER 3: LLM CACHE =====
    let agentOutput: any;

    if (ctx.llmCache) {
      const estimatedTokens = estimateTokenCount(msgs);
      const cachedResponse = ctx.llmCache.get(msgs, estimatedTokens);

      if (cachedResponse) {
        console.log('[LLMCache] Cache hit, saved', estimatedTokens, 'tokens');
        agentOutput = cachedResponse;
      } else {
        // LLM cache miss, call LLM
        console.log('[LLMCache] Cache miss, calling LLM');
        const structuredResult = await retry({
          func: () =>
            ctx.llm.invokeStructured(
              {
                schema: AgentOutputFn(actionSchema),
                options: { temperature: 0 },
              },
              msgs
            ),
        });

        if (!structuredResult.parsed) {
          throw new Error("Failed to get structured output from LLM");
        }

        agentOutput = structuredResult.parsed;

        // Store in LLM cache
        ctx.llmCache.set(msgs, agentOutput, ctx.llm.model || 'unknown');
      }
    } else {
      // No LLM cache, normal flow
      const structuredResult = await retry({
        func: () =>
          ctx.llm.invokeStructured(
            {
              schema: AgentOutputFn(actionSchema),
              options: { temperature: 0 },
            },
            msgs
          ),
      });

      if (!structuredResult.parsed) {
        throw new Error("Failed to get structured output from LLM");
      }

      agentOutput = structuredResult.parsed;
    }

    // ===== EXECUTE ACTIONS =====
    const agentStepActions = agentOutput.actions;
    const actionOutputs: ActionOutput[] = [];

    for (const action of agentStepActions) {
      // Handle complete action
      if (action.type === "complete") {
        taskState.status = TaskStatus.COMPLETED;
        const actionDefinition = ctx.actions.find(
          (actionDefinition) => actionDefinition.type === "complete"
        );
        if (actionDefinition) {
          output =
            (await actionDefinition.completeAction?.(action.params)) ??
            "No complete action found";
        } else {
          output = "No complete action found";
        }
      }

      // Execute action
      const actionOutput = await runAction(
        action as ActionType,
        domState,
        page,
        ctx
      );
      actionOutputs.push(actionOutput);

      // ===== STORE IN ACTION CACHE =====
      // If action succeeded, cache it for next time
      if (
        actionOutput.success &&
        ctx.actionCache &&
        currStep === 0 // Only cache single-step tasks
      ) {
        const element = domState.elements.get(action.params.elementId);

        if (element) {
          const method = action.type === 'clickElement'
            ? 'click'
            : action.type === 'inputText'
            ? 'input'
            : action.type === 'selectOption'
            ? 'select'
            : null;

          if (method) {
            ctx.actionCache.set(
              taskState.task,
              page.url(),
              action.params.elementId,
              element.xpath,
              method
            );
            console.log('[ActionCache] Cached action for next time');
          }
        }
      }

      await sleep(2000);
    }

    // ... rest of task loop
  }

  // ... return task output
};

/**
 * Execute a cached action directly
 */
async function executeCachedAction(
  cached: CachedAction,
  page: Page
): Promise<boolean> {
  try {
    const locator = page.locator(`xpath=${cached.xpath}`);

    switch (cached.method) {
      case 'click':
        await locator.click({ timeout: 3000 });
        return true;

      case 'input':
        // For input actions, we'd need to cache the text too
        // For now, fall through to LLM
        return false;

      case 'select':
        // For select actions, we'd need to cache the option too
        return false;

      default:
        return false;
    }
  } catch (error) {
    console.error('[ActionCache] Failed to execute cached action:', error);
    return false;
  }
}

/**
 * Estimate token count for messages (rough approximation)
 */
function estimateTokenCount(messages: HyperAgentMessage[]): number {
  let total = 0;

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += Math.ceil(msg.content.length / 4); // ~4 chars per token
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text') {
          total += Math.ceil(part.text.length / 4);
        } else if (part.type === 'image') {
          total += 1000; // Rough estimate for images
        }
      }
    }
  }

  return total;
}
```

---

### 5. Update Context Building

#### **File: `src/agent/tools/agent.ts`** (MODIFY)

```typescript
// Pass caches to runAgentTask
const taskState: TaskState = { ... };

return await runAgentTask(
  {
    llm: this.llm,
    actions: this.getActions(params?.outputSchema),
    tokenLimit: this.tokenLimit,
    debug: this.debug,
    mcpClient: this.mcpClient,
    variables: this._variables,
    actionConfig: this.actionConfig,
    actionCache: this.actionCache,  // ADD
    llmCache: this.llmCache,        // ADD
    domMode: this.domMode,          // ADD
  },
  taskState,
  params
);
```

---

## Usage Examples

### Example 1: Basic Usage
```typescript
const agent = new HyperAgent({
  cache: {
    enabled: true, // Enable both caches with defaults
  },
});

const page = await agent.getCurrentPage();
await page.goto('https://example.com/login');

// First call: Full LLM flow (2000ms, $0.02)
await page.ai('click the login button');

// Refresh page
await page.reload();

// Second call: Action cache hit (80ms, $0.00)!
await page.ai('click the login button');

// Check stats
const stats = agent.getCacheStats();
console.log('Action cache hit rate:', stats.actionCache.hitRate);
// Output: 0.5 (50% hit rate after 2 calls)
```

### Example 2: Custom Configuration
```typescript
const agent = new HyperAgent({
  cache: {
    enabled: true,
    actionCache: {
      enabled: true,
      maxSize: 2000,
      ttl: 1000 * 60 * 60 * 48, // 48 hours
    },
    llmCache: {
      enabled: true,
      maxSize: 1000,
      ttl: 1000 * 60 * 30, // 30 minutes
    },
    persistence: {
      enabled: true,
      path: './my-cache.json',
    },
  },
});
```

### Example 3: Development/Testing
```typescript
const agent = new HyperAgent({
  cache: {
    enabled: true,
    persistence: {
      enabled: true,
      path: './test-cache.json', // Persist across test runs
    },
  },
});

// Run tests multiple times
for (let i = 0; i < 10; i++) {
  await page.ai('fill login form');  // Fast after first run
}

// Clear cache between test suites
agent.clearCache();
```

---

## Testing Strategy

### Test 1: Cache Hit Rate
```typescript
async function testCacheHitRate() {
  const agent = new HyperAgent({ cache: { enabled: true } });
  const page = await agent.getCurrentPage();

  await page.goto('https://example.com');

  // Run same action 10 times
  for (let i = 0; i < 10; i++) {
    await page.reload();
    await page.ai('click the search button');
  }

  const stats = agent.getCacheStats()!;
  console.log('Hit rate:', stats.actionCache.hitRate);
  // Expected: 90% (9/10 hits after first miss)
}
```

### Test 2: Speed Comparison
```typescript
async function testSpeed() {
  // Without cache
  const agent1 = new HyperAgent({ cache: { enabled: false } });
  const start1 = Date.now();
  await page1.ai('click login');
  const duration1 = Date.now() - start1;

  // With cache (second call)
  const agent2 = new HyperAgent({ cache: { enabled: true } });
  await page2.ai('click login'); // First call, populate cache
  const start2 = Date.now();
  await page2.ai('click login'); // Second call, cache hit
  const duration2 = Date.now() - start2;

  console.log('Without cache:', duration1, 'ms');
  console.log('With cache:', duration2, 'ms');
  console.log('Speedup:', (duration1 / duration2).toFixed(1) + 'x');
  // Expected: Without: 2000ms, With: 80ms, Speedup: 25x
}
```

### Test 3: Cache Invalidation
```typescript
async function testInvalidation() {
  const agent = new HyperAgent({ cache: { enabled: true } });
  const page = await agent.getCurrentPage();

  await page.goto('https://example.com');
  await page.ai('click button'); // Cache miss

  // Page structure changes
  await page.evaluate(() => {
    document.querySelector('button')!.remove();
  });

  // Should detect cache invalid and fall back to LLM
  await page.ai('click button'); // Should handle gracefully
}
```

---

## Performance Metrics

### Expected Results

| Scenario | No Cache | Action Cache | LLM Cache | Both |
|----------|----------|--------------|-----------|------|
| **First call** | 2,000ms | 2,000ms | 2,000ms | 2,000ms |
| **Repeat (same URL)** | 2,000ms | **80ms** | 150ms | **80ms** |
| **Similar page** | 2,000ms | 2,000ms | **150ms** | **150ms** |
| **Cost per call** | $0.02 | $0.00 | $0.00 | $0.00 |

### ROI Analysis

```
Development scenario: 100 test runs during feature development

Without cache:
- Time: 100 × 2,000ms = 200 seconds (3.3 minutes)
- Cost: 100 × $0.02 = $2.00

With cache:
- Time: 1 × 2,000ms + 99 × 80ms = 9.9 seconds
- Cost: 1 × $0.02 = $0.02

Savings:
- Time saved: 190 seconds (95% reduction)
- Cost saved: $1.98 (99% reduction)
```

---

## Migration Path

### Stage 1: Add Caching (Non-Breaking)
```typescript
// Users opt-in
const agent = new HyperAgent({
  cache: { enabled: true },
});
```

### Stage 2: Enable by Default
```typescript
// After testing, enable by default
const agent = new HyperAgent({
  cache: { enabled: true }, // Default
});
```

### Stage 3: Add Persistence
```typescript
// Automatically persist cache
const agent = new HyperAgent({
  cache: {
    enabled: true,
    persistence: { enabled: true },
  },
});
```

---

## Success Criteria

### Must Have
- ✅ Action cache achieves 70%+ hit rate for repeated tasks
- ✅ Cached actions execute in <100ms
- ✅ No false positives (incorrect cached actions)
- ✅ Graceful fallback when cache invalid

### Should Have
- ✅ LLM cache achieves 40%+ hit rate
- ✅ Persistence works across sessions
- ✅ Cache stats available via API
- ✅ Cache clearing works correctly

### Nice to Have
- ✅ Cache warming (pre-populate common actions)
- ✅ Cache export/import for sharing
- ✅ Cache analytics dashboard
- ✅ Automatic cache tuning

---

## Code Quality Standards

### 1. Type Safety
```typescript
// All cache methods are fully typed
const cached: CachedAction | undefined = cache.get(task, url);
```

### 2. Error Handling
```typescript
// Caches never throw - always return undefined on error
try {
  return cached.response;
} catch {
  return undefined; // Graceful degradation
}
```

### 3. Testing
```typescript
// Unit tests for each cache method
describe('ActionCache', () => {
  it('should cache and retrieve actions', () => { ... });
  it('should normalize URLs correctly', () => { ... });
  it('should handle cache misses gracefully', () => { ... });
});
```

### 4. Documentation
```typescript
/**
 * Normalize URL to remove variations
 * @param url - Full URL with query params
 * @returns Normalized URL (origin + pathname)
 */
private normalizeUrl(url: string): string { ... }
```

### 5. Performance
```typescript
// Use efficient data structures (LRU cache)
// O(1) lookups, O(1) insertions
```

---

## References

- **Stagehand Action Cache:** `/Users/devin/projects/stagehand/stagehand/lib/cache/ActionCache.ts`
- **Stagehand LLM Cache:** `/Users/devin/projects/stagehand/stagehand/lib/cache/LLMCache.ts`
- **LRU Cache Library:** https://www.npmjs.com/package/lru-cache
