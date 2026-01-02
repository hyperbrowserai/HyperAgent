# API Ergonomics Issues And Fixes

Scope: user-facing API and docs for HyperAgent. This list avoids changes to the core agent loop and focuses on what users call and read.

## Issues And Fixes

1) Inconsistent exports and imports
Problem: The root package exports only `HyperAgent` and `TaskStatus`, but the README imports `ActionCacheOutput` from root and examples mix default/named imports and alias the default export. This is confusing and breaks type discovery.
Fix: Re-export common types at root (and update the CommonJS shim), or update docs/examples to import types from `@hyperbrowser/agent/types` and standardize on one import style.
Refs: `src/index.ts`, `package.json`, `README.md`, `examples/llms/openai.ts`, `examples/simple/add-to-amazon-cart.ts`, `examples/mcp/google-sheets/car-price-comparison.ts`

2) HyperPage typing and discoverability
Problem: `getCurrentPage()` returns a Playwright `Page`, so TypeScript does not see HyperPage methods. `HyperPage` and `HyperVariable` are not exported, and helper methods like `performClick` are undocumented.
Fix: Return `Promise<HyperPage>` from `getCurrentPage`, export `HyperPage` and `HyperVariable`, and document helper methods.
Refs: `src/agent/index.ts`, `src/types/agent/types.ts`, `src/types/index.ts`, `src/agent/shared/action-cache-exec.ts`

3) `page.perform` and `aiAction` accept params but ignore them
Problem: Both methods accept `TaskParams` yet `executeSingleActionWithRetry` ignores params and uses hard-coded retries.
Fix: Add a `PerformParams` type (or a dedicated `SingleActionParams`) with `maxRetries`, `retryDelayMs`, and optional `timeout`, and wire it into the retry logic. Alternatively remove params from the signature to avoid false expectations.
Refs: `src/agent/index.ts`, `src/types/agent/types.ts`

4) Visual mode documentation mismatch
Problem: JSDoc says `page.ai` is always visual, while README says visual mode is optional. Internal comments also say "always visual" even though code uses `enableVisualMode` default false.
Fix: Align JSDoc, README, and internal comments with actual behavior. If needed, add explicit `aiVisual` or `aiText` helpers for clarity.
Refs: `src/types/agent/types.ts`, `README.md`, `src/agent/tools/agent.ts`

5) `page.extract` ergonomics and validation
Problem: You cannot call `page.extract(schema)` directly. When a schema is provided, output is parsed with `JSON.parse` but not validated via zod. Errors are generic and the no-task path always assumes JSON.
Fix: Add overloads or an options object so `page.extract(schema)` works. Validate with `schema.parse` (or use `invokeStructured`) and return typed results with better error messages.
Refs: `src/agent/index.ts`, `src/types/agent/types.ts`

6) `executeTask` with `outputSchema` returns only a string
Problem: Even with `outputSchema`, `executeTask` returns `output` as a JSON string. Users must parse manually and lose type safety.
Fix: Add `executeTaskStructured` or return `outputParsed` when `outputSchema` is provided. Update README examples to show typed results.
Refs: `src/agent/tools/agent.ts`, `src/types/agent/types.ts`, `README.md`

7) Async task ergonomics
Problem: `executeTaskAsync` and `aiAsync` return a `Task` without a completion result promise. There is no documented way to await the final output.
Fix: Return a `TaskHandle` with `result(): Promise<AgentTaskOutput>` or return `{ task, result }`. Document the lifecycle and error handling.
Refs: `src/agent/index.ts`, `src/types/agent/types.ts`

8) `HyperagentError` is not exported
Problem: Users cannot catch a typed error or access `statusCode` without importing a private path.
Fix: Export `HyperagentError` from the root or `@hyperbrowser/agent/types` and document error handling.
Refs: `src/agent/error.ts`, `src/index.ts`

9) `connectorConfig` is exposed but ignored
Problem: The config claims to support `connectorConfig` and says it is mutually exclusive with `browserProvider`, but the constructor does nothing with it.
Fix: Throw or warn when `connectorConfig` is provided until it is implemented, and enforce mutual exclusivity.
Refs: `src/types/config.ts`, `src/agent/index.ts`

10) Local browser provider is headful-only
Problem: `localConfig` excludes `headless` and `channel`, and `LocalBrowserProvider` hard-codes `headless: false` and `channel: "chrome"`.
Fix: Allow headless/channel in config and pass through to Playwright.
Refs: `src/types/config.ts`, `src/browser-providers/local.ts`

11) `debugOptions` do not enable reliably
Problem: `setDebugOptions` runs before `this.debug` is set, so options are disabled even when `debug: true`.
Fix: Set `this.debug` before calling `setDebugOptions`, or pass `params.debug ?? false` explicitly.
Refs: `src/agent/index.ts`, `src/debug/options.ts`

12) `debugDir` is ignored unless debug is true
Problem: Users can pass `debugDir`, but no artifacts are written unless `debug` is enabled.
Fix: Treat `debugDir` as an implicit debug flag or document that `debug: true` is required.
Refs: `src/agent/tools/agent.ts`

13) Action cache argument typing and serialization
Problem: Action cache arguments are coerced to strings, which loses numeric types (for example wait duration, scroll percentage). The type says `string[]` even though some actions are numeric.
Fix: Preserve numbers and widen `ActionCacheEntry.arguments` to `Array<string | number>`. Update replay/script generation accordingly.
Refs: `src/agent/shared/action-cache.ts`, `src/types/agent/types.ts`, `src/agent/shared/action-cache-script.ts`

14) Deprecated `aiAction` still dominates docs
Problem: README says `aiAction` is deprecated, but `docs/cdp-overview.md` still focuses on `aiAction`.
Fix: Update the doc to use `page.perform` or clearly label `aiAction` as an alias.
Refs: `docs/cdp-overview.md`

15) Hidden APIs are not documented
Problem: README omits `aiAsync`, `executeTaskAsync`, `getSession`, `getActionCache`, and `perform*` helpers, which makes discoverability poor.
Fix: Add a "Runtime API" section with signatures and examples.
Refs: `README.md`, `src/agent/index.ts`, `src/agent/shared/action-cache-exec.ts`

16) Default LLM auto-selection only checks OpenAI
Problem: If `OPENAI_API_KEY` is not set, the constructor throws even if other provider keys are present.
Fix: Check for other provider env vars or improve the error to guide users to pass `llm` explicitly.
Refs: `src/agent/index.ts`

17) `registerAction()` is private but users need dynamic registration
Problem: The constructor accepts `customActions` and calls `registerAction()`, but `registerAction()` is marked private. Users can only register custom actions at construction time. If they want to register actions dynamically (e.g., after MCP server connects), there's no public API.
Fix: Make `registerAction()` public to allow dynamic registration after construction.
Refs: `src/agent/index.ts`

18) `runFromActionCache()` sets `fallbackUsed: false` incorrectly
Problem: When replaying cached actions, if a step falls back to calling `page.perform()` instead of using the cached XPath, the `replayStepMeta.fallbackUsed` flag is still set to `false`. This misreports replay fidelity.
Fix: Set `fallbackUsed: true` when the replay falls back to instruction-based execution instead of cached action replay.
Refs: `src/agent/index.ts` (lines 785-820)

19) Error messages lack context (URL, available elements)
Problem: When element finding fails after retries, the error message is generic and doesn't include the current URL, page state, or count of available elements, making debugging difficult.
Fix: Include context in error messages: current URL, element count, and actionable suggestions.
Refs: `src/agent/index.ts` (lines 938-941)

20) MCP methods return `null` on error instead of throwing
Problem: `connectToMCPServer()` returns `null` on failure but also logs the error to console. This mixes two error signaling patterns and prevents users from using try-catch for error handling.
Fix: Throw `HyperagentError` instead of returning `null` so users can catch and handle errors programmatically.
Refs: `src/agent/index.ts` (lines 1390-1413)

21) Both `hyperbrowserConfig` and `localConfig` can be set without warning
Problem: The config allows both `hyperbrowserConfig` and `localConfig` to be specified, but only one is used depending on `browserProvider`. If a user sets the wrong config for their provider, it's silently ignored.
Fix: Warn or throw when the unused config is provided, or use discriminated unions to enforce mutual exclusivity at the type level.
Refs: `src/types/config.ts`, `src/agent/index.ts`
