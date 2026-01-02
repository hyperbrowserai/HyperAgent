# API Ergonomics Roadmap (Prioritized)

This roadmap translates `docs/api-ergonomics.md` into an execution plan that agents can pick up immediately. Each phase is ordered by impact and risk, with specific tasks and acceptance criteria.

## Guiding Principles

- Prefer low-risk docs and type fixes first.
- Avoid breaking changes unless clearly justified and documented.
- Keep source of truth in `src/` and update docs/examples alongside API changes.

## Phase 0: Docs And Quick Fixes (Low Risk, High Impact)

Goals: remove confusion for new users and fix obvious bugs without major refactoring.

Tasks (in priority order):
1. Fix `debugOptions` enablement bug: set `this.debug` before calling `setDebugOptions` (Issue 11). This is a one-line swap that fixes a silent failure where debug options are ignored.
2. Update docs to de-emphasize deprecated `aiAction` and use `page.perform` (Issue 14).
3. Add a "Runtime API" section listing `aiAsync`, `executeTaskAsync`, `getSession`, `getActionCache`, and `perform*` helpers (Issue 15).
4. Align visual mode messaging across README and JSDoc ("visual optional via `enableVisualMode`") (Issue 4).
5. Document that `debugDir` is honored only when debug is enabled (Issue 12).
6. Standardize docs/examples on one import style (recommend named import `import { HyperAgent }`) and point to the correct types entrypoint (Issue 1, doc-only part).

Acceptance criteria:
- `debugOptions` toggles take effect when `debug: true` (bug fix verified).
- README and `docs/cdp-overview.md` show `page.perform` instead of `aiAction`.
- README includes a concise runtime API table.
- Visual mode documentation is consistent across README and JSDoc.
- Docs explicitly note `debug: true` requirement for `debugDir`.

## Phase 1: Export, Type, And Config Cleanup (Low Risk, Medium Impact)

Goals: make the API discoverable in TypeScript, remove obvious footguns, and fix low-risk config gaps.

Tasks (in priority order):
1. Re-export commonly used types at root (or update README/examples to `@hyperbrowser/agent/types`) and update the CommonJS shim to match (Issue 1).
2. Export `HyperPage`, `HyperVariable`, and `HyperagentError` (Issues 2, 8).
3. Return `Promise<HyperPage>` from `getCurrentPage()` (Issue 2). Note: this is backwards-compatible since `HyperPage` extends `Page`.
4. Widen `ActionCacheEntry.arguments` to `Array<string | number>` and preserve numeric values end-to-end (Issue 13).
5. Add a runtime guard: throw when `connectorConfig` is provided, and validate mutual exclusivity with `browserProvider` (Issue 9).
6. Allow `headless` and `channel` in `localConfig`, pass through to Playwright (Issue 10). This is a non-breaking additive change—just remove the `Omit` wrappers and pass options through.
7. Add a console warning when `page.perform`/`aiAction` receives params that are currently ignored (Issue 3, interim fix). Full implementation deferred to Phase 2.
8. Make `registerAction()` public to allow dynamic action registration after construction (Issue 17).
9. Fix `runFromActionCache()` to set `fallbackUsed: true` when falling back to instruction-based execution (Issue 18).
10. Warn when both `hyperbrowserConfig` and `localConfig` are provided but only one is used (Issue 21).

Acceptance criteria:
- TypeScript auto-completion exposes `HyperPage` helpers from `getCurrentPage()`.
- Root exports include `HyperagentError` and common types (or docs use `/types`).
- Action cache replay scripts preserve numeric values (wait duration, scroll percentage).
- Passing `connectorConfig` throws an error with clear guidance: "connectorConfig is reserved for Phase 4; use browserProvider instead."
- Passing both `connectorConfig` and `browserProvider` together throws: "connectorConfig and browserProvider are mutually exclusive."
- `localConfig` accepts `headless` and `channel` options.
- Passing unsupported params to `page.perform` logs a warning (e.g., "maxRetries is not yet supported").
- `agent.registerAction(action)` is callable after construction.
- Action cache replay correctly reports `fallbackUsed: true` when using instruction fallback.
- Providing unused config (e.g., `hyperbrowserConfig` with `browserProvider: "Local"`) logs a warning.

## Phase 2: Behavior Improvements (Medium Risk, High Impact)

Goals: make the API feel predictable and configurable.

Tasks (in priority order):
1. Introduce a `PerformParams` type and wire it into retry logic for `page.perform`/`aiAction` (Issue 3). This completes the interim warning added in Phase 1.
2. Improve default LLM selection: check common env vars (`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, etc.) or produce a clearer error with guidance (Issue 16).
3. Make `debugDir` implicitly enable debug, or add a new flag like `debugArtifacts` to keep behavior explicit (Issue 12, behavior part).
4. Expand `page.extract` overloads to accept `schema` directly and validate with zod (Issue 5). **Breaking change note:** Users catching generic errors may need to update error handling when zod validation is introduced.
5. Add context to error messages: include current URL, element count, and actionable suggestions when element finding fails (Issue 19).
6. Make `connectToMCPServer()` throw `HyperagentError` instead of returning `null` on failure (Issue 20). **Breaking change note:** Callers checking for `null` return must switch to try-catch.

Acceptance criteria:
- `page.perform` retries and delay are configurable per call.
- Error messages guide users to set provider-specific keys or pass `llm` explicitly.
- `page.extract(schema)` returns typed output and throws zod validation errors on mismatch.
- Element-not-found errors include URL and element count for debugging.
- `connectToMCPServer()` throws on failure; callers can use try-catch for error handling.
- Existing tests continue to pass after each change.

## Phase 3: API Enhancements (Higher Risk, Lower Priority)

Goals: add higher-level ergonomics without breaking existing flows. These are important improvements but depend on earlier phases being stable.

Tasks (in priority order):
1. Add `executeTaskStructured` or return `outputParsed` when `outputSchema` is provided (Issue 6).
2. Return a Task handle with a `result()` Promise (or `{ task, result }`) for async runs (Issue 7).
3. If desired, split `page.ai` into explicit `aiVisual` and `aiText` helpers for clarity (Issue 4 enhancement).

Acceptance criteria:
- Structured outputs do not require `JSON.parse` at call sites.
- Async workflows can await completion without custom event wiring.
- Visual vs text modes are explicit and documented.

## Execution Order (Recommended)

1) Phase 0 (docs + quick fixes) - quickest confidence boost and fixes a silent bug.
2) Phase 1 (exports/types/config) - unlocks TypeScript usability and CI-friendly config.
3) Phase 2 (behavior changes) - improves real-world ergonomics.
4) Phase 3 (new APIs) - high value but depends on earlier phases being stable.

## Notes For Agents

- Do not edit generated files in `dist/` or `cli.sh`; modify source and run `yarn build` if needed.
- Keep changes scoped; update README/examples alongside API changes.
- **Add tests for all behavior changes.** Even seemingly trivial changes (retry logic, error messages) can break downstream users. The bar is "if it changes runtime behavior, it needs a test."
- Run existing tests after each change to catch regressions early.

## Parallelization Strategy

Some tasks modify the same files. To avoid merge conflicts when running agents in parallel:

**Safe to parallelize (no file conflicts):**
- P0.1 (debugOptions) ✅
- P0.2 (aiAction docs) — only if not running with P0.3/P0.4/P0.5
- P1.6 (headless/channel) ✅

**Must run sequentially within phase (same files):**

*Phase 0 - README conflicts:*
- P0.3, P0.4, P0.5, P0.6 all touch `README.md` → run sequentially or merge carefully

*Phase 1 - `src/agent/index.ts` conflicts:*
- P1.3, P1.5, P1.7, P1.8, P1.9, P1.10 all modify `src/agent/index.ts` → run sequentially

*Phase 1 - `src/index.ts` conflicts:*
- P1.1, P1.2 both modify `src/index.ts` → run together or sequentially

*Phase 1 - `src/types/agent/types.ts` conflicts:*
- P1.4 modifies types → coordinate with P2.1, P2.4

*Phase 2 - Heavy `src/agent/index.ts` edits:*
- P2.1, P2.2, P2.3, P2.4, P2.5, P2.6 all modify `src/agent/index.ts` → run sequentially after Phase 1 is merged

**Recommended batch order:**
1. **Batch A (parallel):** P0.1, P1.6
2. **Batch B (sequential):** P0.2 → P0.3 → P0.4 → P0.5 → P0.6 (README chain)
3. **Batch C (sequential):** P1.1 + P1.2 (can be one PR)
4. **Batch D (sequential):** P1.3 → P1.5 → P1.7 → P1.8 → P1.9 → P1.10 (index.ts chain)
5. **Batch E:** P1.4 (types, standalone)
6. **Batch F (sequential, after D merges):** P2.1 → P2.2 → P2.3 → P2.4 → P2.5 → P2.6
7. **Batch G:** Phase 3 (after Phase 2 stabilizes)

---

## Implementation Details

This section provides the specific details agents need to execute each task autonomously.

### Phase 0 Details

**P0.1 - Fix debugOptions bug**
- File: `src/agent/index.ts`
- Current (broken): Line ~126 calls `setDebugOptions(params.debugOptions, this.debug)` but `this.debug` isn't set until line ~142.
- Fix: Move line 142 (`this.debug = params.debug ?? false;`) to before line 126, or pass `params.debug ?? false` directly to `setDebugOptions`.

**P0.3 - Runtime API section format**
Add a markdown table to README.md after the main API section:

```markdown
## Runtime API

| Method | Description |
|--------|-------------|
| `page.ai(task, params?)` | Execute multi-step task with visual mode |
| `page.perform(instruction, params?)` | Execute single action with a11y mode |
| `page.extract(task?, schema?, params?)` | Extract structured data from page |
| `page.aiAsync(task, params?)` | Start async task, returns `Task` handle |
| `agent.executeTaskAsync(task, params?)` | Start async task on agent |
| `agent.getSession()` | Get current browser session |
| `page.getActionCache(taskId)` | Retrieve action cache for replay |
| `page.runFromActionCache(cache, params?)` | Replay cached actions |
| `page.perform*(xpath, ...)` | Granular helpers: `performClick`, `performFill`, `performType`, etc. |
```

**P0.4 - Visual mode correct messaging**
The correct message is: "Visual mode is disabled by default. Enable with `enableVisualMode: true` in TaskParams."
- Update JSDoc for `page.ai` in `src/types/agent/types.ts` to remove "Always visual" claim
- Update README to be consistent with this message

### Phase 1 Details

**P1.1 - Types to re-export at root**
Add these exports to `src/index.ts`:
```typescript
export {
  TaskStatus,
  HyperAgent,
  // Add these:
  ActionCacheOutput,
  ActionCacheEntry,
  ActionCacheReplayResult,
  TaskParams,
  TaskOutput,
  AgentTaskOutput,
  Task,
  HyperVariable,
  RunFromActionCacheParams,
} from "@/types";
export { HyperPage } from "@/types/agent/types";
export { HyperagentError } from "./agent/error";
```
Update the CommonJS shim at the bottom of `src/index.ts` to match.

**P1.7 - Params to warn about**
In `page.perform`/`aiAction`, warn if any of these are passed (they're currently ignored):
- `maxSteps` (for single actions, this doesn't apply)
- Any param not in: `debugDir`, `outputSchema`, `onStep`, `onComplete`, `debugOnAgentOutput`, `enableVisualMode`, `useDomCache`, `enableDomStreaming`

Actually, the real issue is that `TaskParams` is accepted but retry behavior uses hardcoded `AIACTION_CONFIG`. Warn if user passes params expecting retry control. Simplest approach: log warning at top of `executeSingleActionWithRetry` if params object is non-empty.

**P1.8 - Make registerAction() public**
- File: `src/agent/index.ts`
- Current: `private async registerAction(action: AgentActionDefinition)`
- Fix: Change `private` to `public`
```typescript
public async registerAction(action: AgentActionDefinition): Promise<void> {
  // existing implementation
}
```
This allows users to dynamically add actions after MCP servers connect or based on runtime conditions.

**P1.9 - Fix fallbackUsed flag in runFromActionCache()**
- File: `src/agent/index.ts` (lines 785-820)
- Problem: When falling back to `page.perform()`, `fallbackUsed` is set to `false`
- Fix: In the `else if (step.instruction)` branch, ensure the returned result has `replayStepMeta.fallbackUsed: true`
```typescript
} else if (step.instruction) {
  result = await hyperPage.perform(step.instruction);
  // Ensure fallbackUsed is correctly set
  if (result.replayStepMeta) {
    result.replayStepMeta.fallbackUsed = true;
  } else {
    result.replayStepMeta = { usedCachedAction: false, fallbackUsed: true };
  }
}
```

**P1.10 - Warn on unused config**
- File: `src/agent/index.ts` (constructor)
- Add warning when mismatched config is provided:
```typescript
if (this.browserProviderType === "Local" && params.hyperbrowserConfig) {
  console.warn("[HyperAgent] hyperbrowserConfig is ignored when browserProvider is 'Local'");
}
if (this.browserProviderType === "Hyperbrowser" && params.localConfig) {
  console.warn("[HyperAgent] localConfig is ignored when browserProvider is 'Hyperbrowser'");
}
```

### Phase 2 Details

**P2.1 - PerformParams type definition**
```typescript
export interface PerformParams extends TaskParams {
  maxRetries?: number;      // default: 10 (from AIACTION_CONFIG.MAX_RETRIES)
  retryDelayMs?: number;    // default: 1000 (from AIACTION_CONFIG.RETRY_DELAY_MS)
  timeout?: number;         // default: 3500 (from AIACTION_CONFIG.CLICK_TIMEOUT)
}
```
Wire these into `executeSingleActionWithRetry` to replace the hardcoded values.

**P2.2 - LLM env var check order**
Check in this order (first match wins):
1. `OPENAI_API_KEY` → `{ provider: "openai", model: "gpt-4o" }`
2. `ANTHROPIC_API_KEY` → `{ provider: "anthropic", model: "claude-opus-4-5" }`
3. `GOOGLE_API_KEY` or `GEMINI_API_KEY` → `{ provider: "google", model: "gemini-2.0-flash" }`

If none found, throw with message:
```
No LLM provider configured. Set one of: OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY, or pass 'llm' explicitly to the constructor.
```

**P2.3 - debugDir behavior decision**
Chosen approach: **`debugDir` implicitly enables debug**.
- In constructor, if `params.debugDir` is set and `params.debug` is not explicitly `false`, set `this.debug = true`.
- This is the least surprising behavior for users.

**P2.4 - page.extract overload signatures**
```typescript
// Current signature (keep for backwards compat):
extract<T extends z.ZodType<any> | undefined = undefined>(
  task?: string,
  outputSchema?: T,
  params?: Omit<TaskParams, "outputSchema">
): Promise<T extends z.ZodType<any> ? z.infer<T> : string>;

// New overload (schema-first):
extract<T extends z.ZodType<any>>(
  schema: T,
  params?: Omit<TaskParams, "outputSchema">
): Promise<z.infer<T>>;
```
Implementation: detect if first arg is a ZodType, route accordingly. Validate result with `schema.parse()` and throw `ZodError` on mismatch.

**P2.5 - Add context to error messages**
- File: `src/agent/index.ts` (lines 938-941)
- Current error:
```typescript
throw new HyperagentError(
  `No elements found for instruction: "${instruction}" after ${maxRetries} retry attempts. The instruction may be too vague, the element may not exist, or the page may not have fully loaded.`,
  404
);
```
- Fix: Include URL and element count:
```typescript
throw new HyperagentError(
  `No elements found for instruction: "${instruction}" after ${maxRetries} retry attempts.\n` +
  `URL: ${page.url()}\n` +
  `Available elements: ${result.domState?.elements?.size ?? 'unknown'}\n` +
  `Suggestions: Try a more specific instruction, wait for page to load, or check if the element exists.`,
  404
);
```
Apply similar improvements to other error messages in the file that lack context.

**P2.6 - Make connectToMCPServer() throw instead of returning null**
- File: `src/agent/index.ts` (lines 1390-1413)
- Current:
```typescript
public async connectToMCPServer(serverConfig: MCPServerConfig): Promise<string | null> {
  try {
    // ...
    return serverId;
  } catch (error) {
    console.error(`Failed to connect to MCP server:`, error);
    return null;
  }
}
```
- Fix:
```typescript
public async connectToMCPServer(serverConfig: MCPServerConfig): Promise<string> {
  try {
    // ...
    return serverId;
  } catch (error) {
    throw new HyperagentError(
      `Failed to connect to MCP server: ${error instanceof Error ? error.message : String(error)}`,
      500
    );
  }
}
```
Update return type from `Promise<string | null>` to `Promise<string>`.
**Breaking change:** Callers checking `if (result === null)` must switch to try-catch.

### Phase 3 Details

**P3.1 - executeTaskStructured return type**
```typescript
interface StructuredTaskOutput<T> extends TaskOutput {
  outputParsed: T;  // Parsed and validated output
}

// New method:
executeTaskStructured<T extends z.ZodType<any>>(
  task: string,
  outputSchema: T,
  params?: Omit<TaskParams, "outputSchema">
): Promise<StructuredTaskOutput<z.infer<T>>>;
```

**P3.2 - TaskHandle interface**
```typescript
interface TaskHandle<T = TaskOutput> extends Task {
  result(): Promise<T>;  // Resolves when task completes, rejects on failure
}
```
Update `executeTaskAsync` and `aiAsync` to return `TaskHandle` instead of `Task`.

**P3.3 - aiVisual/aiText decision**
**Skip this task.** The current `enableVisualMode` param is sufficient. Adding separate methods creates API surface bloat without clear benefit. Mark as "won't do" unless user feedback indicates otherwise.

---

## File Reference Map

Quick lookup for which files each task touches:

| Task | Primary Files | Secondary Files |
|------|---------------|-----------------|
| P0.1 debugOptions | `src/agent/index.ts` | - |
| P0.2 aiAction docs | `docs/cdp-overview.md` | `README.md` |
| P0.3 Runtime API | `README.md` | - |
| P0.4 Visual mode | `src/types/agent/types.ts`, `README.md` | `src/agent/tools/agent.ts` |
| P0.5 debugDir docs | `README.md` | - |
| P0.6 Import style | `README.md`, `examples/**/*.ts` | - |
| P1.1 Re-export types | `src/index.ts` | - |
| P1.2 Export classes | `src/index.ts` | `src/agent/error.ts` |
| P1.3 getCurrentPage | `src/agent/index.ts` | `src/types/agent/types.ts` |
| P1.4 ActionCache args | `src/types/agent/types.ts`, `src/agent/shared/action-cache.ts` | `src/agent/shared/action-cache-script.ts` |
| P1.5 connectorConfig guard | `src/agent/index.ts` | `src/types/config.ts` |
| P1.6 headless/channel | `src/browser-providers/local.ts`, `src/types/config.ts` | - |
| P1.7 Param warnings | `src/agent/index.ts` | - |
| P1.8 registerAction public | `src/agent/index.ts` | - |
| P1.9 fallbackUsed fix | `src/agent/index.ts` | - |
| P1.10 config warning | `src/agent/index.ts` | - |
| P2.1 PerformParams | `src/types/agent/types.ts`, `src/agent/index.ts` | - |
| P2.2 LLM env vars | `src/agent/index.ts` | - |
| P2.3 debugDir implicit | `src/agent/index.ts` | - |
| P2.4 extract overloads | `src/agent/index.ts`, `src/types/agent/types.ts` | - |
| P2.5 error context | `src/agent/index.ts` | - |
| P2.6 MCP throw | `src/agent/index.ts` | - |
| P3.1 executeTaskStructured | `src/agent/tools/agent.ts`, `src/types/agent/types.ts` | - |
| P3.2 TaskHandle | `src/agent/index.ts`, `src/types/agent/types.ts` | - |
