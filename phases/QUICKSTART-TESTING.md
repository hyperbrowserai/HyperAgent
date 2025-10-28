# Quick Start: Testing Phase 1 Implementation

## Prerequisites

1. **Set up environment variables** (create `.env` file):
   ```bash
   OPENAI_API_KEY=sk-...
   ```

2. **Install dependencies**:
   ```bash
   yarn install
   ```

3. **Build the project**:
   ```bash
   yarn build
   ```

## Step 1: Run Baseline Evaluation (Current Implementation)

### Single task smoke test:
```bash
yarn ts-node -r tsconfig-paths/register scripts/run-webvoyager-eval.ts "Allrecipes--0"
```

### Small subset (10 tasks, recommended):
```bash
yarn ts-node -r tsconfig-paths/register scripts/run-webvoyager-eval.ts "Allrecipes--{0..9}"
```

### Full Allrecipes suite (45 tasks):
```bash
yarn ts-node -r tsconfig-paths/register scripts/run-webvoyager-eval.ts "Allrecipes--*"
```

**Expected duration**:
- 1 task: ~2-5 minutes
- 10 tasks: ~30-60 minutes (parallel execution)
- 45 tasks: ~2-4 hours

**Cost estimate** (GPT-4o):
- 1 task: ~$0.10-0.30
- 10 tasks: ~$1-3
- 45 tasks: ~$5-15

**Output location**:
- `logs/<timestamp>/summary.json` - Overall results
- `logs/<timestamp>/<eval-id>/` - Per-task logs and screenshots

## Step 2: Implement Phase 1 Changes

See [phase-1-accessibility-tree.md](./phase-1-accessibility-tree.md) for detailed implementation instructions.

**Key changes**:
1. Create `src/context-providers/a11y-dom/` directory
2. Implement CDP accessibility functions
3. Update `src/agent/tools/agent.ts` to use new DOM provider
4. Add feature flag configuration

## Step 3: Run Phase 1 Evaluation

After implementing changes, run the same tests:

```bash
yarn build
yarn ts-node -r tsconfig-paths/register scripts/run-webvoyager-eval.ts "Allrecipes--{0..9}"
```

**Output location**:
- `logs/<new-timestamp>/summary.json`

## Step 4: Compare Results

```bash
yarn ts-node scripts/compare-eval-runs.ts \
  logs/<baseline-timestamp>/summary.json \
  logs/<phase1-timestamp>/summary.json
```

**Example**:
```bash
yarn ts-node scripts/compare-eval-runs.ts \
  logs/2025-10-28T20-00-00-000Z/summary.json \
  logs/2025-10-28T22-00-00-000Z/summary.json
```

**Output**: Beautiful terminal report showing:
- Success rate comparison
- Newly passed tasks
- Newly failed tasks (regressions)
- Overall verdict

## Quick Commands Reference

### Find latest baseline run:
```bash
ls -lt logs/ | head -n 5
```

### View summary for a specific run:
```bash
cat logs/<timestamp>/summary.json | jq '.successRate'
```

### View detailed results for a specific task:
```bash
cat logs/<timestamp>/<eval-id>/webvoyager-eval.log
```

### Count total tasks in eval suite:
```bash
wc -l evals/WebVoyager_data.jsonl
```

### List all Allrecipes tasks:
```bash
grep "Allrecipes" evals/WebVoyager_data.jsonl | jq -r '.id'
```

### Run specific task by ID:
```bash
yarn ts-node -r tsconfig-paths/register scripts/run-webvoyager-eval.ts "Allrecipes--5"
```

### Run multiple specific tasks:
```bash
yarn ts-node -r tsconfig-paths/register scripts/run-webvoyager-eval.ts "Allrecipes--{0,5,10}"
```

### Run with glob pattern:
```bash
yarn ts-node -r tsconfig-paths/register scripts/run-webvoyager-eval.ts "Amazon--*"
```

## Troubleshooting

### Error: "OPENAI_API_KEY environment variable is missing"
**Solution**: Create `.env` file with your OpenAI API key:
```bash
echo "OPENAI_API_KEY=sk-your-key-here" > .env
```

### Error: "Module not found"
**Solution**: Build the project first:
```bash
yarn build
```

### Error: "No evals found matching glob pattern"
**Solution**: Check the pattern matches eval IDs. List available IDs:
```bash
cat evals/WebVoyager_data.jsonl | jq -r '.id' | head -20
```

### Eval times out or hangs
**Solution**:
- Check browser is not stuck on a modal/popup
- Increase timeout in `scripts/run-webvoyager-eval.ts` (line 314-316)
- Reduce concurrency if system is overloaded

### Memory issues with parallel execution
**Solution**: Reduce concurrency in `scripts/run-webvoyager-eval.ts`:
```typescript
const results = await runEvalsBatch(evals, references, runId, 5); // Default is 25
```

## Success Criteria Checklist

After running comparisons, verify:

- [ ] Success rate ≥ baseline (no regressions)
- [ ] Zero "golden" test cases failed
- [ ] Net positive or neutral task pass count
- [ ] Comparison report shows improvements

**Bonus goals**:
- [ ] Success rate +5% or better
- [ ] Token usage reduced by 50-70%
- [ ] Speed improved by 30-50%

## Next Steps

### If Phase 1 passes:
1. Run on larger test set (all Allrecipes, then Amazon)
2. Document improvements in phase completion report
3. Proceed to Phase 2 (Caching)

### If Phase 1 has regressions:
1. Review `logs/<run-id>/<eval-id>/` for failed tasks
2. Compare screenshots: `final-state.png`
3. Read execution logs: `webvoyager-eval.log`
4. Identify patterns in failures
5. Fix implementation bugs
6. Re-run subset tests

### If Phase 1 shows no improvement:
1. Verify implementation is actually being used
2. Add debug logging to confirm new code path
3. Check if token reduction is actually happening
4. Review if accessibility tree has sufficient information

## Tips

- **Start small**: Always test on 1 task first, then 10, then full suite
- **Monitor costs**: Check OpenAI dashboard for actual spending
- **Save baseline**: Keep baseline summary.json safe for all comparisons
- **Document changes**: Note what you changed between runs in git commits
- **Parallel runs**: Use `run_in_background: true` if testing both implementations simultaneously

## Example Workflow

```bash
# 1. Baseline smoke test (1 task)
yarn ts-node -r tsconfig-paths/register scripts/run-webvoyager-eval.ts "Allrecipes--0"

# 2. Check it worked
ls -l logs/

# 3. Baseline subset (10 tasks)
yarn ts-node -r tsconfig-paths/register scripts/run-webvoyager-eval.ts "Allrecipes--{0..9}"

# 4. Save baseline run ID
export BASELINE_RUN=$(ls -t logs/ | head -n 1)
echo "Baseline: $BASELINE_RUN"

# 5. Implement Phase 1 changes
# ... code changes ...

# 6. Rebuild
yarn build

# 7. Run Phase 1 eval (same 10 tasks)
yarn ts-node -r tsconfig-paths/register scripts/run-webvoyager-eval.ts "Allrecipes--{0..9}"

# 8. Save Phase 1 run ID
export PHASE1_RUN=$(ls -t logs/ | head -n 1)
echo "Phase 1: $PHASE1_RUN"

# 9. Compare
yarn ts-node scripts/compare-eval-runs.ts \
  logs/$BASELINE_RUN/summary.json \
  logs/$PHASE1_RUN/summary.json

# 10. Review comparison report
cat logs/$PHASE1_RUN/comparison-report.json | jq
```

---

**Ready to start?** Run the baseline first:

```bash
yarn ts-node -r tsconfig-paths/register scripts/run-webvoyager-eval.ts "Allrecipes--{0..9}"
```
