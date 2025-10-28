# HyperAgent Improvement Phases - Master Overview

## Document Structure

Each phase has been broken down into a detailed markdown file with:
- **Executive Summary:** Quick overview of goals and impact
- **Why This Improvement:** Problems with current implementation
- **High-Level Concepts:** Architectural changes explained
- **Detailed Implementation:** Complete code with file paths and line numbers
- **Testing Strategy:** How to validate improvements
- **Success Criteria:** Metrics to measure success
- **Code Quality Standards:** Best practices to follow

---

## Phase Documents

### [Phase 1: Accessibility Tree Foundation](./phase-1-accessibility-tree.md)
**Goal:** Replace visual DOM+overlay with Chrome's native Accessibility Tree

**High-Level Concepts Covered:**
1. **Determine Interactive Elements** - Use Chrome's accessibility engine instead of manual DOM traversal
2. **Add Identifiers** - Use CDP `backendNodeId` + XPath instead of canvas overlay numbers
3. **Playwright Interaction** - Use XPath selectors instead of CSS paths

**Impact:**
- 70% token reduction (8K-15K → 2K-5K)
- 2-4x faster actions (2000ms → 500-800ms)
- Better semantic understanding
- No visual occlusion

**Files to Create:**
- `src/context-providers/a11y-dom/types.ts`
- `src/context-providers/a11y-dom/get-tree.ts`
- `src/agent/messages/prompts/a11y-system-prompt.ts`

**Files to Modify:**
- `src/context-providers/dom/index.ts`
- `src/agent/actions/click-element.ts`
- `src/agent/actions/input-text.ts`
- `src/agent/tools/agent.ts`
- `src/types/config.ts`

---

### [Phase 2: Dual-Layer Caching](./phase-2-caching.md)
**Goal:** Implement Action Cache + LLM Cache for 20-30x speed on repeated tasks

**High-Level Concepts Covered:**
5. **Caching Architecture** - Two-tier caching strategy (Action Cache + LLM Cache)

**Impact:**
- 96% speed improvement for cached actions (2000ms → 80ms)
- 99% cost reduction for cached actions ($0.02 → $0.00)
- 70%+ cache hit rate for typical usage

**Files to Create:**
- `src/cache/action-cache.ts`
- `src/cache/llm-cache.ts`

**Files to Modify:**
- `src/types/config.ts`
- `src/agent/index.ts`
- `src/agent/tools/agent.ts`

**Key Features:**
- LRU eviction policy
- TTL-based expiration (24h for actions, 1h for LLM)
- URL normalization
- Cache persistence to disk
- Cache statistics API

---

### [Phase 3: Improved System Prompts](./phase-3-system-prompts.md)
**Goal:** Optimize LLM instructions for better accuracy and understanding

**High-Level Concepts Covered:**
4. **System Prompts** - Mode-specific prompts (A11y, Visual, Hybrid) with task augmentation

**Impact:**
- 10-15% accuracy improvement
- Better reasoning in LLM responses
- Fewer hallucinated actions
- Clear action descriptions

**Files to Create:**
- `src/agent/messages/prompts/a11y-system-prompt.ts`
- `src/agent/messages/prompts/visual-system-prompt.ts`
- `src/agent/messages/prompts/hybrid-system-prompt.ts`
- `src/agent/messages/prompts/task-augmentations.ts`

**Files to Modify:**
- `src/agent/tools/agent.ts`

**Prompt Features:**
- Explains accessibility tree format
- Shows concrete examples
- Lists common mistakes to avoid
- Task-specific guidance (forms, navigation, extraction, search)
- Best practices for element selection

---

### [Phase 4: Self-Healing & Multiple Selectors](./phase-4-self-healing.md)
**Goal:** Implement retry logic and fallback selector strategies

**High-Level Concepts Covered:**
3. **Playwright Interaction (Enhanced)** - Multiple selector strategies with fallbacks

**Impact:**
- +20-30% success rate on dynamic sites (60-75% → 85-95%)
- Automatic recovery from common failures
- 4 fallback strategies (XPath, CSS, Text, ARIA)
- +1-2s latency only on failures (worth it)

**Files to Create:**
- `src/utils/element-finder.ts`
- `src/agent/tools/self-healing.ts`

**Files to Modify:**
- `src/agent/tools/agent.ts`
- `src/types/config.ts`
- `src/agent/index.ts`

**Self-Healing Strategies:**
1. Primary: XPath from accessibility tree
2. Fallback 1: CSS selector
3. Fallback 2: Text-based matching
4. Fallback 3: ARIA label matching
5. Fallback 4: Role + name matching
6. Re-observation: Fresh DOM extraction if all fail

---

## Implementation Order

### Recommended Sequence

**Week 1-2: Phase 1 (Foundation)**
- **Priority:** HIGH (enables all other improvements)
- **Dependencies:** None
- **Risk:** Medium (major architectural change)
- **Benefit:** Immediate 70% token reduction

**Week 3-4: Phase 3 (Prompts)**
- **Priority:** HIGH (quick win, low risk)
- **Dependencies:** Phase 1 (needs a11y prompt)
- **Risk:** Low (just text changes)
- **Benefit:** +10-15% accuracy

**Week 5-6: Phase 2 (Caching)**
- **Priority:** MEDIUM (optimization, not core)
- **Dependencies:** Phase 1 (caches elementId from a11y tree)
- **Risk:** Low (optional feature, graceful fallback)
- **Benefit:** 96% speed on repeated tasks

**Week 7-8: Phase 4 (Self-Healing)**
- **Priority:** MEDIUM (improves reliability)
- **Dependencies:** Phase 1 (uses xpath and element metadata)
- **Risk:** Medium (complex retry logic)
- **Benefit:** +20-30% success on dynamic sites

---

## High-Level Concepts Summary

### 1. Determine Interactive Elements

**Current:** Manual DOM traversal with custom rules
```typescript
// Manual check every element
for (let element of allElements) {
  if (isInteractive(element)) {
    elements.push(element);
  }
}
```

**New:** Chrome's accessibility engine
```typescript
// Chrome already knows which are interactive
const { nodes } = await client.send('Accessibility.getFullAXTree');
// Filter to interactive roles only
```

**Why Better:**
- ✅ Chrome's engine is battle-tested
- ✅ Handles ARIA correctly
- ✅ Includes semantic meaning
- ✅ Faster (no manual traversal)

---

### 2. Add Identifiers in DOM

**Current:** Canvas overlay with numbered labels
```
Visual screenshot shows:
[1] [2] [3] overlaid on elements
```

**New:** CDP backend node IDs + XPath
```typescript
// Each element has stable ID
element.backendDOMNodeId = "abc123"
element.xpath = "/html/body/form/button[1]"
```

**Why Better:**
- ✅ No visual occlusion
- ✅ More stable identifiers
- ✅ XPath more reliable than CSS
- ✅ Programmatic, not visual

---

### 3. Playwright Interaction

**Current:** Single CSS selector strategy
```typescript
const locator = page.locator(element.cssPath);
// If CSS breaks, action fails
```

**New:** Multiple fallback strategies
```typescript
// Try 5 different ways to find element:
1. XPath (primary)
2. CSS path
3. Text matching
4. ARIA label
5. Role + name

// If element moved, re-observe DOM and try again
```

**Why Better:**
- ✅ Resilient to page changes
- ✅ Self-healing on failures
- ✅ Multiple ways to locate same element
- ✅ 85-95% success vs 60-75%

---

### 4. System Prompts

**Current:** Generic prompt for all scenarios
```
"You are a browser automation assistant..."
[Generic instructions]
```

**New:** Mode-specific + task-specific prompts
```typescript
// A11y mode: Explain tree format
A11Y_SYSTEM_PROMPT = `
Format: [elementId] role: name
Example: [abc123] button: Submit
...
`

// Task-specific: Form filling
if (task.includes('fill')) {
  prompt += FORM_FILLING_GUIDANCE;
}
```

**Why Better:**
- ✅ LLM understands format better
- ✅ Fewer mistakes
- ✅ Better element selection
- ✅ Task-optimized guidance

---

### 5. Caching

**Current:** No caching, every action calls LLM
```
User: "click login"
→ Extract DOM (500ms)
→ Call LLM (800ms)
→ Execute (200ms)
Total: 1500ms, $0.02

User: "click login" (again)
→ Extract DOM (500ms) ← Repeat!
→ Call LLM (800ms) ← Repeat!
→ Execute (200ms)
Total: 1500ms, $0.02 ← Same cost!
```

**New:** Two-tier caching
```
User: "click login"
→ Check Action Cache (10ms)
→ MISS
→ Extract DOM (500ms)
→ Check LLM Cache (10ms)
→ MISS
→ Call LLM (800ms)
→ Execute (200ms)
→ Cache result
Total: 1500ms, $0.02

User: "click login" (again)
→ Check Action Cache (10ms)
→ HIT! Execute directly (70ms)
Total: 80ms, $0.00 ← 19x faster, free!
```

**Why Better:**
- ✅ 96% speed improvement for cached
- ✅ 99% cost reduction for cached
- ✅ 70%+ hit rate typical usage
- ✅ Two-tier for flexibility

---

## Migration Strategy

### Stage 1: Non-Breaking Addition (v0.12.0)
- ✅ Add a11y DOM support
- ✅ Add caching (opt-in)
- ✅ Add new prompts
- ✅ Add self-healing (opt-in)
- ✅ Keep visual mode as default
- ✅ No breaking changes

**Release:** Beta with opt-in flags
```typescript
const agent = new HyperAgent({
  domMode: 'a11y', // Opt-in
  cache: { enabled: true }, // Opt-in
  selfHealing: { enabled: true }, // Opt-in
});
```

### Stage 2: Gradual Migration (v0.13.0)
- ✅ Change default `domMode` to `'auto'` (chooses a11y for most tasks)
- ✅ Enable caching by default
- ✅ Enable self-healing by default
- ⚠️ Deprecation warnings for visual mode
- ✅ Still supports visual mode for compatibility

**Release:** Stable with new defaults
```typescript
const agent = new HyperAgent({
  // Defaults now use new features
  // domMode: 'auto' (uses a11y)
  // cache: { enabled: true }
  // selfHealing: { enabled: true }
});
```

### Stage 3: Breaking Changes (v0.14.0)
- ✅ Remove visual mode entirely
- ✅ Remove canvas overlay code
- ✅ `domMode` defaults to `'a11y'`
- ❌ Breaking: Action params use `elementId` (string) not `index` (number)
- 📚 Migration guide for users

**Release:** Major version with breaking changes
```typescript
// Old API (removed):
{ type: "clickElement", params: { index: 5 } }

// New API:
{ type: "clickElement", params: { elementId: "abc123" } }
```

---

## Expected Results

### Performance Improvements

| Metric | Current | After All Phases | Improvement |
|--------|---------|-----------------|-------------|
| **Tokens per action** | 8K-15K | 2K-5K | 70% reduction |
| **Speed (uncached)** | 2,000ms | 500-800ms | 2-4x faster |
| **Speed (cached)** | N/A | 80ms | 25x faster |
| **Cost per action** | $0.02 | $0.005 | 75% reduction |
| **Cost (cached)** | $0.02 | $0.00 | 100% reduction |
| **Success rate (static)** | 85% | 90% | +6% |
| **Success rate (dynamic)** | 60-75% | 85-95% | +20-30% |
| **Cache hit rate** | 0% | 70% | N/A |

### Real-World Scenarios

#### Scenario 1: Simple Click Task
```
Task: "Click the login button"

Before (Current):
1. Extract DOM with overlay: 1,200ms
2. Composite screenshot: 300ms
3. Call LLM: 800ms
4. Execute action: 200ms
Total: 2,500ms, 12,000 tokens, $0.024

After (Phase 1 + 3):
1. Extract a11y tree: 400ms
2. Call LLM: 700ms (better prompt)
3. Execute action: 150ms
Total: 1,250ms, 3,500 tokens, $0.007
Improvement: 50% faster, 71% fewer tokens

After (Phase 1 + 2 + 3 - cached):
1. Check cache: 10ms
2. Verify element: 50ms
3. Execute action: 20ms
Total: 80ms, 0 tokens, $0.00
Improvement: 96% faster, 100% cost reduction
```

#### Scenario 2: Form Filling
```
Task: "Fill login form and submit"

Before (Current):
Step 1: Fill email (2,500ms, $0.024)
Step 2: Fill password (2,500ms, $0.024)
Step 3: Click submit (2,500ms, $0.024)
Total: 7,500ms, $0.072

After (All Phases):
Step 1: Fill email (1,100ms, $0.007)
Step 2: Fill password (1,100ms, $0.007)
Step 3: Click submit (1,100ms, $0.007)
Total: 3,300ms, $0.021
Improvement: 56% faster, 71% cost reduction

After (All Phases - cached):
Step 1: Fill email (80ms, $0.00)
Step 2: Fill password (80ms, $0.00)
Step 3: Click submit (80ms, $0.00)
Total: 240ms, $0.00
Improvement: 97% faster, 100% cost reduction
```

#### Scenario 3: Dynamic SPA Site
```
Task: "Click button that appears after animation"

Before (Current):
1. Extract DOM: 1,200ms
2. LLM: 800ms
3. Try to click: Element not ready yet
4. ❌ Fail
Success rate: 60%

After (All Phases):
1. Extract a11y tree: 400ms
2. LLM (with better prompt): 700ms
3. Try to click: Element not ready
4. Wait 500ms (self-healing)
5. Re-observe DOM: 400ms
6. Try XPath: ❌
7. Try text match: ✅ Found!
8. Click successfully
Success rate: 90%
Improvement: +50% success rate
```

---

## Testing Checklist

### Phase 1: Accessibility Tree
- [ ] A11y tree extracts all interactive elements
- [ ] XPath selectors work reliably
- [ ] Token count reduced by 60%+
- [ ] Speed improved by 2x+
- [ ] No breaking changes to existing API

### Phase 2: Caching
- [ ] Action cache hit rate >70% for repeated tasks
- [ ] LLM cache hit rate >40% for similar tasks
- [ ] Cached actions execute in <100ms
- [ ] Cache persistence works across sessions
- [ ] Cache invalidation works correctly

### Phase 3: System Prompts
- [ ] A11y prompt accuracy +10% vs generic prompt
- [ ] LLM provides better reasoning
- [ ] Fewer hallucinated actions
- [ ] Task augmentation improves specific task types

### Phase 4: Self-Healing
- [ ] Dynamic site success rate >85%
- [ ] Re-observation finds moved elements
- [ ] Multiple selector strategies work
- [ ] Overhead <100ms on successful first attempt
- [ ] Maximum retries respected (no infinite loops)

---

## Code Quality Standards

All phases follow these standards:

### 1. TypeScript
- ✅ Full type safety (no `any` except in edge cases)
- ✅ Interfaces for all data structures
- ✅ Enums for constants
- ✅ JSDoc comments on public APIs

### 2. Error Handling
- ✅ Never throw errors in main flow (return `Result<T, Error>`)
- ✅ Graceful degradation on failures
- ✅ Clear error messages
- ✅ Logging at appropriate levels

### 3. Testing
- ✅ Unit tests for utilities
- ✅ Integration tests for main flows
- ✅ Benchmark tests for performance
- ✅ E2E tests on real websites

### 4. Performance
- ✅ Async/await everywhere (no blocking)
- ✅ Timeouts on all operations
- ✅ Efficient data structures (Map, Set, LRU)
- ✅ Minimal DOM operations

### 5. Documentation
- ✅ README for each module
- ✅ Inline comments for complex logic
- ✅ Examples in docs
- ✅ Migration guides

---

## Getting Started

### For Reviewers
1. Read this README first for overview
2. Read Phase 1 (most important architectural change)
3. Read other phases based on priority/interest

### For Implementers
1. Start with Phase 1 (foundation for everything else)
2. Test Phase 1 thoroughly before proceeding
3. Implement Phases 2-4 in parallel (mostly independent)
4. Integration test all phases together

### For Users
1. Opt-in to new features in v0.12.0
2. Test in development environment
3. Report bugs/feedback
4. Migrate fully in v0.13.0+

---

## Questions?

Each phase document has detailed implementation, but if you need clarification:
- Check the "Why This Improvement?" section for motivation
- Check the "High-Level Concepts" section for architecture
- Check the "Code Changes Required" section for specific files
- Check the references at bottom for Stagehand/Skyvern examples

Happy improving! 🚀
