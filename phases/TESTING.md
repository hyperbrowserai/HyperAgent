# Testing Plan for Phase 1: Accessibility Tree Implementation

## Overview

This document outlines the testing strategy to validate that Phase 1 (Accessibility Tree implementation) improves HyperAgent's performance and accuracy compared to the current visual DOM approach.

## Test Environment

### Eval Suite: WebVoyager
- **Total tasks**: 642 real-world web navigation tasks
- **Websites covered**: Allrecipes, Amazon, and others
- **Task types**: Recipe search, product search, data extraction, navigation
- **Reference answers**: Ground truth data with expected outputs
- **Automated scoring**: LLM-based evaluation comparing actual vs expected outputs

### Current Implementation (Baseline)
- **DOM extraction**: Visual approach with canvas overlays
- **Token usage**: 8,000-15,000 tokens per step
- **Speed**: ~1.5-3s per action (dominated by screenshot/canvas rendering)
- **Accuracy**: To be measured

### Phase 1 Implementation (Target)
- **DOM extraction**: Chrome DevTools Protocol Accessibility Tree
- **Expected token usage**: 2,000-5,000 tokens per step (60-70% reduction)
- **Expected speed**: ~50-70% faster per action
- **Expected accuracy**: Same or better (±5-10% improvement goal)

## Testing Phases

### Phase 0: Single Task Smoke Test ✅
**Purpose**: Validate eval infrastructure works

```bash
yarn ts-node -r tsconfig-paths/register scripts/run-webvoyager-eval.ts "Allrecipes--0"
```

**What we're checking**:
- Eval runner executes successfully
- Logs are created in `logs/<run-id>/`
- Summary JSON is generated
- Screenshots are captured
- LLM evaluation completes

### Phase 1: Baseline Evaluation (Subset)
**Purpose**: Establish current performance metrics

```bash
yarn ts-node -r tsconfig-paths/register scripts/run-webvoyager-eval.ts "Allrecipes--{0..9}"
```

**Test subset**: First 10 Allrecipes tasks
**Duration**: ~30-60 minutes
**Metrics to capture**:
- Success rate (%)
- Average steps per task
- Pass/fail breakdown
- Specific task IDs that pass/fail

### Phase 2: Phase 1 Implementation
**Purpose**: Implement accessibility tree changes

**Files to modify**:
1. Create `src/context-providers/a11y-dom/` directory
2. Implement CDP accessibility functions:
   - `getAccessibilityTree()`
   - `buildAXNodeMap()`
   - `enhanceAXNodes()` (Stagehand's role replacement)
3. Update `src/agent/tools/agent.ts` to use new DOM provider
4. Add configuration flag `useAccessibilityTree: boolean`

**Implementation approach**:
- Non-breaking: Add new code alongside existing
- Feature flag: Allow switching between old/new via config
- Backward compatible: Don't remove old code yet

### Phase 3: Phase 1 Evaluation (Subset)
**Purpose**: Measure Phase 1 performance on same subset

```bash
# After implementing Phase 1 changes
yarn ts-node -r tsconfig-paths/register scripts/run-webvoyager-eval.ts "Allrecipes--{0..9}"
```

**Same test subset**: First 10 Allrecipes tasks
**Configuration**: Enable `useAccessibilityTree: true` in eval script

### Phase 4: Comparison & Analysis
**Purpose**: Quantify improvements or regressions

```bash
yarn ts-node scripts/compare-eval-runs.ts \
  logs/<baseline-run-id>/summary.json \
  logs/<phase1-run-id>/summary.json
```

**Analysis checklist**:
- [ ] Success rate delta (goal: ≥0%, stretch: +5-10%)
- [ ] Newly passed tasks (improvements)
- [ ] Newly failed tasks (regressions)
- [ ] Still passing tasks (stable)
- [ ] Still failing tasks (stable)

**Manual review**: For each newly failed task:
1. Read eval logs for both runs
2. Compare screenshots
3. Identify root cause:
   - Implementation bug?
   - Missing element in AX tree?
   - Selector strategy failure?
4. Create GitHub issue for tracking

### Phase 5: Extended Testing (if Phase 4 passes)
**Purpose**: Validate across more tasks

**Expansion plan**:
1. All Allrecipes tasks: `"Allrecipes--*"` (~45 tasks)
2. Amazon tasks: `"Amazon--*"` (~100 tasks)
3. Full suite: All 642 tasks (if time/budget permits)

## Success Criteria

Phase 1 is considered **SUCCESSFUL** if:

### ✅ Hard Requirements
1. **No regressions on "golden" tasks**: Tasks marked as `type: "golden"` in reference data must still pass
2. **Net positive or neutral accuracy**: Success rate ≥ baseline (0% or better delta)
3. **No breaking changes**: Existing code still works with feature flag off

### 🎯 Soft Requirements (Goals)
1. **Accuracy improvement**: +5-10% success rate increase
2. **Token reduction**: 50-70% fewer tokens per step (8K-15K → 2K-5K)
3. **Speed improvement**: 30-50% faster per action
4. **Cost savings**: Proportional to token reduction

### ⚠️ Acceptable Trade-offs
- Minor token increase (up to +10%) if accuracy improves significantly (+15%+)
- Slight speed decrease (up to -10%) if accuracy improves significantly (+15%+)

### ❌ Failure Conditions
- Success rate drops by >5%
- Any "golden" test cases fail
- Implementation breaks existing functionality

## Metrics Collection

### Automated Metrics (from eval runner)
- Total evaluations
- Correct evaluations
- Failed evaluations
- Success rate (%)
- Per-task pass/fail status

### Manual Metrics (to be added)
For future iterations, instrument code to capture:
- Average tokens per step
- Average time per action
- Total cost per task (at current LLM pricing)
- Memory usage

## Iteration Strategy

If Phase 1 fails acceptance criteria:

### If accuracy drops:
1. Review newly failed tasks for patterns
2. Identify missing information in AX tree
3. Enhance node selection logic
4. Add fallback selectors
5. Re-test on failed subset

### If implementation is too complex:
1. Simplify to most impactful changes only
2. Remove experimental features
3. Focus on core AX tree replacement
4. Defer advanced features (caching, self-healing) to later phases

### If tests are flaky:
1. Add retry logic for network-dependent tasks
2. Increase timeouts for slow pages
3. Improve element wait strategies
4. Add more robust error handling

## Next Steps After Phase 1

If Phase 1 is successful:
1. **Phase 2**: Implement caching (action + LLM response cache)
2. **Phase 3**: Optimize system prompts (mode-specific, task-specific)
3. **Phase 4**: Add self-healing (retry logic, fallback selectors)

If Phase 1 needs iteration:
1. Create GitHub issues for each regression
2. Prioritize fixes by impact
3. Re-run subset tests after each fix
4. Proceed to full suite only when stable

## Running the Full Test Suite

### Baseline (Current Implementation)
```bash
# Run all tasks (takes several hours)
yarn ts-node -r tsconfig-paths/register scripts/run-webvoyager-eval.ts

# Or run specific websites
yarn ts-node -r tsconfig-paths/register scripts/run-webvoyager-eval.ts "Allrecipes--*"
yarn ts-node -r tsconfig-paths/register scripts/run-webvoyager-eval.ts "Amazon--*"
```

### Phase 1 (After Implementation)
```bash
# Same commands, but with useAccessibilityTree flag enabled in code
yarn ts-node -r tsconfig-paths/register scripts/run-webvoyager-eval.ts "Allrecipes--*"
```

### Comparison
```bash
yarn ts-node scripts/compare-eval-runs.ts \
  logs/<baseline-timestamp>/summary.json \
  logs/<phase1-timestamp>/summary.json
```

## Log Structure

Each eval run creates:
```
logs/
└── <run-id>/                    # ISO timestamp
    ├── summary.json             # Overall results
    ├── comparison-report.json   # Generated by compare script
    └── <eval-id>/               # Per-task logs
        ├── webvoyager-eval.log  # Detailed execution log
        ├── final-state.png      # Screenshot after task completion
        └── debug/               # Step-by-step debug artifacts
            ├── step-0.png
            ├── step-1.png
            └── ...
```

## Cost Estimates

### Per-task cost (GPT-4o pricing: $5/1M input, $15/1M output)
- **Current**: ~$0.10-0.30 per task (varies by complexity)
- **Phase 1**: ~$0.03-0.10 per task (60-70% reduction expected)

### Full suite cost
- **Baseline** (642 tasks): ~$64-190
- **Phase 1** (642 tasks): ~$19-64 (expected)
- **Comparison runs** (both baselines): ~$130-380 total

**Recommendation**: Start with 10-task subset ($2-6) before committing to full suite.

## Timeline

- **Phase 0** (Smoke test): 10 minutes
- **Phase 1** (Baseline subset): 1 hour
- **Phase 2** (Implementation): 4-8 hours
- **Phase 3** (Phase 1 eval): 1 hour
- **Phase 4** (Comparison): 10 minutes
- **Phase 5** (Extended testing): 4-8 hours

**Total estimated time**: 1-2 days for complete Phase 1 validation

## Notes

- All evals use GPT-4o for LLM-based evaluation (consistent across runs)
- Browser viewport: 1500x1500 (configured in eval script)
- Max steps per task: 25 (timeout after 10 minutes)
- Concurrency: 25 parallel tasks (configurable)
- Retry logic: 3 attempts per task on failure
