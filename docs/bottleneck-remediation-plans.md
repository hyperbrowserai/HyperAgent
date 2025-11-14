# Bottleneck Remediation Plans

Status: draft  
Owner: HyperAgent Core Team  
Scope: Phase 3 follow-ups / pre-work for Phase 4+

Each section details the problem statement, goals, phased plan, validation strategy, and risks for the major issues observed during the Phase‑3 CDP deep dive (excluding the deprecated standalone CDPConnection).

---

## 1. DOM Capture Overhead (getA11yDOM)

**Problem**  
Every agent step rebuilds the entire accessibility + DOM map synchronously: `DOM.getDocument`, AX tree fetch per frame, bounding boxes, scroll detection, frame graph sync. Cross-origin frames serially block the planner loop, and even when visual mode is off we still pay most of the bounding-box setup cost before skipping the overlay/screenshot.

**Goals**
1. Reduce DOM capture latency per step by ≥40% on OOPIF-heavy sites.  
2. Allow planner prompt construction to start before iframe traversal completes.  
3. Avoid redundant screenshot composition when visual mode is off.

**Plan**
1. **Incremental DOM cache**
   - Introduce `DomSnapshotCache` keyed by `page.mainFrame()._guid` (or CDP frameId) to store backend maps + AX nodes.
   - Add invalidation triggers: navigation, DOM diff checksum change, manual `ctx.invalidateDomCache()`.
2. **Parallel frame fetch**
   - Fetch main frame AX tree synchronously, kick off iframe fetches via `Promise.allSettled` to allow partial prompt building.
   - Pipe results through a queue so `buildAgentStepMessages` receives the main tree immediately. (We keep a single LLM call; no “true streaming” prompt changes.)
3. **Screenshot/overlay gating**
   - Respect `params.enableVisualMode` to avoid overlay work when disabled (already true, but move checks earlier to skip bounding box prep).
   - When visual mode is enabled, reuse the last screenshot if DOM diff is below a threshold.

**TODOs**
- [x] Implement `DomSnapshotCache` (`src/context-providers/a11y-dom/dom-cache.ts`) and hook invalidation into CDP action dispatch + navigation events.
- [x] Expose `ctx.invalidateDomCache()` and integrate cache reuse inside `getA11yDOM`.
- [x] Split main-frame vs iframe fetch (Promise-based) and wire chunk callbacks (kept behind `enableDomStreaming`, still one LLM call).
- [x] Guard bounding-box injection/screenshot work earlier and add screenshot reuse via hashing/change detection.
- [x] Add profiling script (`scripts/profile-dom-capture.ts`) plus timing telemetry; pending unit tests for cache invalidation.
- [ ] Add cache invalidation tests / regression harness to ensure no stale DOM is served.

**Validation**
- Benchmark script (`scripts/profile-dom-capture.ts`) capturing step latency with/without cache across: news site, google maps, youtube embed.
- Log cache hit ratio and iframe parallelism stats to `debug/dom-capture.json`.

**Risks & Mitigations**
- Stale cache after user input → force invalidation when CDP actions mutate the DOM (hook into `dispatchCDPAction`).
- Memory growth from cached AX trees → cap by N steps and evict oldest entries.

---

## 2. Dual LLM Calls per Action

**Problem**  
Planner produces a generic instruction, then `actElement` triggers a second `examineDom` call to pick elements, doubling latency and token spend per step.

**Goals**
1. Collapse to a single LLM inference per step.  
2. Maintain current success rate for element targeting (±2%).  
3. Keep structured output backwards compatible for custom actions.

**Current Flow (Deep Dive)**  
- `runAgentTask` calls `ctx.llm.invokeStructured(...)` with `AgentOutputFn`, which currently only requests high-level params (`actElement: { instruction: string }`, etc.).  
- `ActElementActionDefinition.run` receives the instruction, then immediately calls `examineDom` (a second LLM invocation) to translate that instruction into `{ elementId, method, arguments }`.  
- We then resolve the encodedId (`resolveElement` / `getElementLocator`) and perform the CDP action.  
- `page.aiAction`/`executeSingleAction` use the same `examineDom` helper (`findElementWithInstruction`), so any change must keep that path working.

**Plan**
1. **Augment planner schema + prompts**
   - Extend `AgentOutputFn` so `actElement` actions return a structured payload:
     ```ts
     {
       instruction: string; // reasoning / intent
       elementId: EncodedId; // e.g. "0-5125"
       method: "click" | "fill" | ...;
       arguments?: unknown[];
       confidence: number;
     }
     ```
   - Update `SYSTEM_PROMPT` and the message builder to explicitly tell the planner to reference encoded IDs from the DOM section (`=== Elements ===`). Include few-shot examples covering main-frame, iframe, and multi-step flows.
   - **Prompt changes (exact additions):**
     1. In `SYSTEM_PROMPT`, add a block:
        > “When proposing an `actElement` action you MUST choose an `elementId` from the `=== Elements ===` section. Use the format `{ frameIndex-backendNodeId }`, e.g. `0-5125`. Also include the CDP method (click/fill/etc.), any arguments, and a confidence score (0-1).”
     2. In the user instructions appended by `buildAgentStepMessages`, append a reminder:
        > “For each candidate action, reference the encoded IDs shown above. Example:\n> `actElement.elementId = \"0-42\"` corresponds to `[Main Frame] button: Login`.”
     3. Add a few-shot pair to the planner prompt demonstrating the desired JSON (main frame + iframe example). The assistant response should include:
        ```json
        {
          "action": {
            "type": "actElement",
            "params": {
              "instruction": "Click the Login button to open the form",
              "elementId": "0-42",
              "method": "click",
              "arguments": [],
              "confidence": 0.92
            }
          }
        }
        ```
        and an iframe example with `elementId: "1-103"` to show multi-frame usage.
2. **Agent plumbing**
   - Validate planner output before executing: ensure `elementId` exists in `domState.elements`, `method` is allowed, etc.  
   - On validation failure, treat it as a hard error (no automatic `examineDom` fallback); this enforces the new contract and keeps telemetry honest.  
   - Update `ActElementActionDefinition` to use planner-provided element IDs directly.  
   - Emit telemetry counters (`plannerElementHit`, `plannerElementInvalid`) so we can track accuracy.
3. **Prompt tuning & evaluation**
   - Build an offline replay harness: feed recorded DOM + prompts through the new schema, compare success rate to baseline `examineDom`.  
   - Capture metrics (percentage of steps with valid element IDs, action success, token usage) before enabling by default.
4. **Compatibility considerations**
   - `page.aiAction` remains unchanged (it still calls `examineDom` since it only receives an instruction string).  
   - No feature flag: once implemented, the planner contract changes globally for multi-step tasks.  
   - Document the new schema so custom actions / external tooling know about `elementId` fields when reading planner output.

**Validation**
- Offline replay harness: feed recorded DOM + planner prompts through new schema and compare action accuracy vs. baseline trace.
- Runtime metrics: log per-step inference count, fallback usage, action success rate, and planner-element accuracy.

**Risks**
- LLM might hallucinate IDs; mitigate with validator that checks ID existence before execution.
- Larger schema increases token usage slightly; monitor tokens-per-step to ensure net savings after removing the second call.
- If DOM state formatting regresses, planner output quality will crater (add tests around the DOM encoder to catch this).

---

## 3. Lifecycle Waiting Strategy

**Problem**  
`waitForSettledDOM` is invoked after every action, always enabling Network domain and waiting 500 ms of idle, regardless of whether the action actually triggered navigation or network work.

**Goals**
1. Cut average post-action wait time in half.  
2. Avoid unnecessary CDP session churn for lifecycle monitoring.  
3. Preserve reliability for navigation-heavy flows.

**Plan**
1. **Shared lifecycle session**
   - Allocate `LifecycleSessionManager` per page that keeps Network/Page domains enabled once.
   - `waitForSettledDOM` reuses this session and only reattaches listeners when page reloads.
2. **Adaptive wait guard**
   - Add a stalled-request sweep (e.g., force-complete requests older than ~2 s, similar to Stagehand v3) so long-lived iframe loads don’t block the quiet timer forever. Log whenever we forcibly drop a request.
   - Keep the existing 500 ms quiet window and global timeout, but capture stats (requests seen, peak inflight, forced drops) in telemetry.

**Validation**
- Instrumentation counters: time spent in lifecycle waits, number of session creations, false positives (action finished before navigation).
- Regression suite focusing on navigation, file uploads, SPA updates.

**Risks**
- Under-waiting causing premature DOM reads → add per-action override to force full wait when needed.
- Shared session might miss events after crashes → monitor `session.on('Detached')` to recreate automatically.

---

## 4. CDP Session Churn

**Problem**  
DOM extraction, screenshots, lifecycle waits, and manual actions each call `cdpClient.createSession` and immediately detach, causing dozens of short-lived sessions per step.

**Goals**
1. Reuse long-lived CDP sessions per concern (dom, lifecycle, screenshot).  
2. Reduce CDP attach/detach chatter (target <5 session creations per task step).  
3. Simplify cleanup on page close.

**Plan**
1. **Session pool abstraction**
   - Extend `PlaywrightCDPClient` with `acquireSession(kind: 'dom' | 'lifecycle' | 'screenshot')`.
   - Sessions are lazily created, cached, and released only on page close or fatal errors.
2. **Consumer updates**
   - `getA11yDOM` requests `kind: 'dom'`.  
   - `waitForSettledDOM` requests `kind: 'lifecycle'`.  
   - Screenshot helper uses `kind: 'screenshot'`.
3. **Cleanup hooks**
   - Hook into `page.on('close')` to dispose the pool once; remove per-call `detach`.

**Validation**
- Add debug counter for active sessions and reuse hits.
- Stress test with long tasks (≥20 steps) to ensure no leaks.

**Risks**
- Sessions might become invalid after navigation; pool should detect failures and recreate lazily.
- Playwright private API changes → isolate pool in adapter so future adjustments are centralized.

---

## 5. Frame Graph Authoritativeness

**Problem**  
`FrameContextManager` exists but only syncs when `getA11yDOM` runs. Element resolution still has a Playwright/XPath path via `resolveFrameByXPath`, so CDP frame metadata is not the single source of truth.

**Goals**
1. Initialize and maintain the FrameGraph continuously while tasks run.  
2. Remove Playwright frame fallback once stability is proven.  
3. Improve observability (snapshots, logs) for frame debugging.

**Plan**
1. **Early initialization**
   - During `runAgentTask` setup, call `frameManager.ensureInitialized()` and keep it alive via a `TaskFrameContext`.
   - Subscribe to frame events even when DOM capture is disabled.
2. **Resolver cutover**
   - Update `resolveElement` to throw if frame metadata is missing (behind feature flag).  
   - Remove `resolveFrameByXPath` and Playwright locator path once telemetry shows <1% fallback usage.
3. **Diagnostics**
   - Emit `frames.json` per step (frameId, parent, sessionId, executionContextId).  
   - Provide `scripts/debug-frame-graph.ts` for manual investigation.

**Validation**
- Unit tests simulating frame attach/detach/navigate events to ensure graph stays in sync.
- E2E tasks involving nested same-origin + cross-origin iframes.

**Risks**
- Initial auto-attach bugs could break element resolution; mitigate with feature flag `cdpFrames`.
- Additional listeners might hurt performance; profile once instrumentation is in place.

---

## 6. Per-Task Feature Controls

**Problem**  
`cdpActions` and future flags are only configurable at agent construction time (`actionConfig`). Callers cannot toggle CDP flows per task or per API call, which blocks gradual rollout and A/B experimentation.

**Goals**
1. Add per-task overrides for CDP behaviors (actions, frame graph usage, visual mode).  
2. Ensure defaults remain backwards compatible.  
3. Surface flag state in debug artifacts.

**Plan**
1. **TaskParams extension**
   - Add `cdpActions?: boolean`, `cdpFrames?: boolean`, `visualMode?: 'auto' | 'always' | 'never'`.
   - In `executeTask`/`runAgentTask`, merge `taskParams` overrides with agent defaults.
2. **Plumbing**
   - Pass resolved flags into `ActionContext`, DOM capture, and frame manager initialization so each subsystem reads from a single source.
3. **Telemetry + Docs**
   - Include flag state in `debug/step-X/metadata.json`.
   - Update README + MIGRATION notes explaining precedence rules.

**Validation**
- Unit tests for the merge logic (agent default vs task override).
- Manual scenario: run same script with flags toggled to verify behavior.

**Risks**
- Flag explosion → keep scope small, document interactions (e.g., `cdpFrames` requires `cdpActions`).
- Existing callers might rely on implicit behavior; maintain default parity and add deprecation notice before changing defaults.

---

These plans can be tracked individually (e.g., GitHub issues or linear tickets) and executed in parallel by different owners. Each section includes the minimum validation required before shipping to end users. Let me know if you’d like this broken down further into sprint-level tasks. 
