# Phase 5 Plan: Core Agent Logic Updates

Objective: refactor the core agent loop (`page.ai`, `executeTask`, `act-element`, etc.) to fully leverage the CDP-based DOM state, interactions, and frame management from Phases 1–4, while improving robustness (retries, streaming control) and maintaining backward-compatible APIs.

Scope aligns with integration roadmap Phase 5 (items 5.1–5.2 and related action execution changes).

---

## 1. Goals
- Replace Playwright-dependent logic inside `findElementWithInstruction`, `act-element`, `executeSingleAction`, and `runAgentTask` with CDP-driven equivalents.
- Optimize DOM fetch + action loop using the new CDP frame/interaction layers.
- Improve error handling and retries (especially for CDP interactions) without reintroducing browser-specific fallbacks.
- Keep existing public APIs (`page.ai`, `page.aiAction`, `HyperAgent.executeTask`) untouched, but internally operate on `GenericPage` + CDP primitives.

---

## 2. Current Pain Points
- `findElementWithInstruction` always fetches a fresh DOM and uses Playwright `waitForSettledDOM`; we now have CDP-based `waitForSettledDOM` and DOM caching opportunities.
- Action context relies on Playwright `Locator`s; CDP interactions need to be wired in instead.
- `runAgentTask` fetches DOM sequentially and blocks while waiting for CDP calls; we can parallelize some steps (e.g., screenshot + DOM).
- Error reporting mixes Playwright exceptions with HyperAgent errors; we need consistent CDP-first error handling.
- Retries are limited (three DOM fetch attempts) and not tuned for CDP interactions.

---

## 3. Workstream A — Element Finding & DOM Flow

### A1. DOM Fetch Pipeline
- Update `runAgentTask` to:
- Use Phase 1 CDP client for DOM extraction (`getA11yDOM`).
- Optionally reuse CDP data between loops if no navigation occurred (simple cache keyed by frame loader IDs).
- Parallelize screenshot capture (`compositeScreenshot`) with DOM printing to reduce per-step latency.
- Invoke the Phase 3 LifecycleWatcher/NetworkManager before DOM capture (`waitForDomNetworkQuiet`) to guarantee the page is idle across all frames.

### A2. `findElementWithInstruction`
- Switch to CDP-based `waitForSettledDOM` (already CDP-driven) and DOM fetch.
- Use Phase 2 `resolveElement` to verify candidate IDs before returning.
- Provide better telemetry: include resolved frameId/backendNodeId, bounding box, and frame ordinal in debug info.
- Add richer error reporting when LLM fails to find the element (include DOM summary, frame metadata).

### A3. Examine DOM Integration
- Adjust `examineDom` context to include `frameId`, `backendNodeId`, bounding box references so future heuristics can use them.
- Ensure the function gracefully handles mismatched IDs (missing from backend map) with actionable errors (for Phase 2 bug triage).

---

## 4. Workstream B — Action Execution Pipeline

### B1. `ActElementAction`
- Replace `getElementLocator` and `executePlaywrightMethod` with `resolveElement` + `executeCDPAction`.
- Store debug info: resolved frameId, bounding box, CDP method invoked.
- Add CDP-specific retries (e.g., if `Input.dispatchMouseEvent` fails due to target detached):
  1. If CDP reports “node not found / detached”, re-fetch DOM, re-resolve element once.
  2. If frame navigated, re-run `waitForDomNetworkQuiet` before retrying.

### B2. `executeSingleAction` (`page.aiAction`)
- Mirror the `ActElementAction` changes but ensure the flow remains single-step:
  1. Wait for settled DOM via CDP.
  2. Fetch DOM state (with bounding boxes).
  3. Run `examineDom`.
  4. Resolve element, run `executeCDPAction`.
  5. Wait for DOM to settle again (CDP).
- Provide more granular debug files (e.g., `cdp-actions.json`) capturing the exact CDP commands, frameId, backendNodeId, coordinates, and timestamps.

### B3. Task Loop Retries
- Introduce per-action retry logic:
  - If a CDP action fails due to transient issues (frame navigation, stale backend node), re-fetch DOM and re-resolve once.
  - Cap retries at 2 per action to avoid infinite loops.
- Integrate with existing `consecutiveFailuresOrWaits` guard and record retry counts in debug output.

### B4. Error Logging & Diagnostics
- Wrap CDP errors into `HyperagentError` with structured context (method, args, frameId, backendNodeId).
- Ensure errors bubble up consistently through `runAgentTask`, `executeTask`, `executeSingleAction`.
- Emit structured logs per action (JSON lines) summarizing: instruction, resolved selector/xpath, frameId, backendNodeId, bounding box, CDP method invoked, retries taken, success/failure.

---

## 5. Workstream C — Action Context & Config

### C1. `ActionContext` Structure
- Add `cdpClient`, `frameGraph`, `cdpCache` references.
- Provide helper functions in `ActionContext`:
  - `resolveElement(encodedId)` → returns `ResolvedCDPElement`.
  - `executeAction(method, args, encodedId)` → wraps retries, logging, and CDP interaction dispatch.
  - `getBoundingBox(encodedId)` → reads from the bounding box cache or issues CDP fallback.
  - `waitForDomIdle()` → thin wrapper around LifecycleWatcher to ensure DOM + network quiet before/after actions.

### C2. Config Flags
- Extend `actionConfig` to include CDP-specific timeouts (click, type).
- Add `cdpActions` + `cdpFrames` flags to `TaskParams` for per-task overrides.

### C3. Debug Hooks
- When `debug` is true, store:
  - CDP command logs per step.
  - `frameGraph.json`.
  - `cdp-cache.json` (e.g., resolved node IDs, execution context IDs, retry metadata).
  - `network-log.json` summarizing NetworkManager events during the step.

---

## 6. Workstream D — Run Loop Enhancements

### D1. Parallelization & Scheduling
- Preload next DOM state while LLM is thinking (if `cdpActions` enabled) to reduce step time.
- Implement optional streaming updates (tie into Phase 4 `GenericPage` connectors) so remote drivers can report progress.
- For long-running actions, periodically emit heartbeat logs with current frame URL, network activity snapshot, and pending requests (via NetworkManager).

### D2. Task State Updates
- Include frameId/backendNodeId in the `AgentStep` debug info so task transcripts reflect CDP data.
- Update result objects to include CDP metadata when available (for auditing).
- Surface DOM diff summaries (from Phase 2) alongside each step so users understand what changed.

### D3. Wait/Retry Strategy
- Revisit `wait` action logic to ensure it works with CDP watchers (use `waitForDomIdle` instead of fixed 2 seconds when possible).
- Automatically trigger DOM refresh when the frame graph reports a navigation or root swap, reducing reliance on coarse timeouts.

---

## 7. Testing Strategy

### T1. Unit Tests
- `act-element.test.ts`: ensure CDP execution path is used, retries behave correctly, errors include frameId/backendNodeId.
- `execute-single-action.test.ts`: covers success/failure flows using mocked CDP interactions.

### T2. Integration Tests
- Run existing scripts (`test-page-ai`, `test-page-iframes`) with `CDP_ACTIONS=1`.
- Add targeted tests for:
  - Failing CDP actions (simulate node becoming stale).
  - Complex iframe navigation (Phase 3 feature).

### T3. Regression Harness
- Add optional `scripts/test-cdp-actions.ts` to run a suite of action instructions (click, fill, select) against a local test page, comparing expected results.

---

## 8. Rollout Plan
1. **Flag default off**: keep `cdpActions` disabled by default; run internal/external smoke tests to validate.
2. **Gradual enablement**: turn on for `page.aiAction` first (easier to debug single-step issues), then for `page.ai`.
3. **Remove Playwright exec**: once stable, delete `executePlaywrightMethod`, `getElementLocator`, and other Playwright-only action paths.
4. **Document migration**: update README/docs to describe the CDP action path and how to enable/disable it.

---

## 9. Deliverables Checklist
- [ ] Updated `findElementWithInstruction` using CDP resolver.
- [ ] `ActionContext` exposes CDP helpers.
- [ ] `act-element` + `executeSingleAction` fully CDP-driven.
- [ ] Enhanced `runAgentTask` with CDP data flow, retries, logging.
- [ ] Error handling + debug artifacts updated for CDP.
- [ ] Unit/integration tests covering new paths.
- [ ] Documentation (flag usage, troubleshooting).

Phase 5 completes the migration to CDP-based agent execution, ensuring both multi-step tasks and single-step actions operate consistently across different browser drivers and connector setups.
