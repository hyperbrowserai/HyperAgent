# HyperAgent Current State (2026-02)

This file summarizes the implementation as it exists today.

## Product surface

HyperAgent exposes a TypeScript SDK for browser automation with three primary page APIs:

- `page.ai(task, params?)` → multi-step autonomous workflow loop
- `page.perform(instruction, params?)` → single granular action (a11y-first)
- `page.extract(task?, schema?, params?)` → extraction helper layered on top of the loop

`page.aiAction()` remains as a deprecated alias to `page.perform()`.

## Runtime architecture

### Main orchestrator
- `src/agent/index.ts` (`HyperAgent`)
  - Browser/context lifecycle
  - Task lifecycle (`executeTask`, `executeTaskAsync`)
  - Page scoping and tab-following behavior
  - Action registration and MCP integration
  - Action-cache replay support

### Agent loop
- `src/agent/tools/agent.ts` (`runAgentTask`)
  - Repeated cycle: DOM capture → message building → structured LLM action → action execution
  - Supports debug artifacts, bounded retry behavior, and cache recording
  - Includes stuck protection for repeated failures/waits and repeated successful no-progress actions
  - `complete` action now determines final success/failure semantics deterministically

### Single-action path
- `executeSingleAction` in `src/agent/index.ts`
  - Uses `findElementWithInstruction` (a11y analyze + retry)
  - Executes through shared `performAction`
  - Supports dedicated perform retry controls (`maxElementRetries`, `retryDelayMs`, `maxContextSwitchRetries`, `contextSwitchRetryDelayMs`)
  - Emits a one-time deprecation warning when compatibility alias `page.aiAction()` is used
  - Writes debug artifacts to `debug/perform/...` via canonical `writePerformDebug`

## DOM context pipeline

- Primary provider: `src/context-providers/a11y-dom/*`
- Produces:
  - Encoded element IDs (`frameIndex-backendNodeId`)
  - `elements` map, `xpathMap`, `backendNodeMap`, `frameMap`
  - Optional bounding boxes and visual overlay in visual mode
- Includes short-lived snapshot caching with explicit invalidation (`dom-cache.ts`)

## CDP integration model

- CDP-first execution and resolution in `src/cdp/*`
- Key modules:
  - `playwright-adapter.ts` → CDP client/session abstraction
  - `frame-context-manager.ts` / `frame-graph.ts` → frame/session/context tracking
  - `element-resolver.ts` → encoded-id to executable CDP element resolution
  - `interactions.ts` → click/type/fill/scroll/etc CDP action dispatch
- Playwright fallback still exists where CDP is unavailable or disabled (`cdpActions: false`)

## LLM layer

- Provider adapters in `src/llm/providers/*`
  - OpenAI, Anthropic, Gemini, DeepSeek
- Unified interfaces in `src/llm/types.ts`
- Structured output path is schema-driven (Zod-first)

## Quality gates and testing

### Automation
- CI workflow: `.github/workflows/ci.yml`
  - Runs lint, build, and test on push/PR

### Local checks
- `yarn lint`
- `yarn build`
- `yarn test`

### Test harness
- Jest + ts-jest configured via `jest.config.cjs`
- Current regression/unit coverage includes:
  - constructor/debug wiring and action registration behavior
  - async task control result promise
  - agent loop complete semantics
  - perform variable interpolation path
  - perform retry option propagation
  - frame listener cleanup lifecycle
  - prompt/message contract checks (open tabs, naming consistency, bounded history)

## Notable recent hardening

- Added async task handle `task.result` for `executeTaskAsync`.
- Fixed debug options initialization ordering.
- Made action registration fail-fast and synchronous.
- Added dedicated perform option typing and handling.
- Added configurable context-switch retry delay for `page.perform`.
- Aligned prompt text with actual registered action names.
- Fixed frame listener bookkeeping to avoid session listener overwrite drift.
- Added compact omitted-history summaries in prompt building to preserve context while respecting prompt budgets.
- Made repeated-success stuck detection progress-aware by incorporating bounded DOM-state signatures.
- Reduced first-party frame false positives in ad/tracking filtering with same-site weak-signal safeguards.
- Centralized page URL normalization into shared utility (`normalizePageUrl`) and reused it across agent loop, perform, and prompt-builder paths.
- Hardened frame metadata normalization in `FrameContextManager` (sanitized/bounded frame URLs and names, trap-safe OOPIF metadata reads).
- Hardened a11y frame resolution fallback logic to keep XPath traversal working when frame enumeration is trap-prone.
- Hardened a11y context-provider diagnostics for build-map, scrollable-detection, and batch bounding-box collection failure paths (sanitized/truncated warnings and bounded identifiers).
- Hardened CDP script-injector diagnostics for script registration/runtime evaluation failures with bounded key/context identifier formatting.
- Hardened CDP element-resolver diagnostics by sanitizing/truncating encoded IDs and frame IDs in failure/warning paths.
- Hardened `PerformanceTracker` warning paths in a11y DOM capture utilities and tightened metadata typing (`unknown` + safe readers) to reduce unsafe runtime assumptions.
- Hardened CLI diagnostics in task-input/stdin/mcp-config flows with consistent control-character stripping and truncation in file-read/raw-mode/config-parse errors.
- Hardened agent-side DOM streaming callback warnings (`dom-capture`) to avoid noisy unbounded callback failure logs.
- Hardened retry helper warning diagnostics for callback/sleep failure paths, preventing control-character and oversized diagnostic leakage.
- Hardened `examineDom` and HTML→Markdown utilities with bounded diagnostic formatting for LLM/tooling conversion failures.
- Hardened perform-action failure formatting with explicit bounded diagnostics, including trap-prone DOM element lookup failures.
- Hardened Anthropic provider structured-output warning diagnostics in schema validation fallback branches.
- Hardened network-settle waiting (`waitForSettledDOM`) with safe listener attach/detach handling, timeout fallback when listener registration fails, and bounded stalled-request diagnostics.
- Added bounded timeout normalization in `waitForSettledDOM` so invalid/non-finite/non-positive waits no longer resolve immediately and oversized values are capped.
- Hardened replay-step diagnostics in `runFromActionCache` to strip control characters in cached-step/page getter failure messages.
- Sanitized control characters in prompt-builder task/step/DOM payload serialization before truncation to keep LLM context inputs clean under malformed runtime values.
- Tightened agent-loop action/output typing by normalizing parsed structured outputs into explicit `AgentOutput`/`ActionType` shapes before runtime dispatch and cache recording.
- Removed direct `as any` casts in OpenAI/Anthropic/DeepSeek/Gemini provider request payload assembly in favor of SDK-derived parameter field typing.
- Added `filterAdTrackingFrames` configuration in `HyperAgent` so CDP frame discovery can optionally include ad/tracking iframes for workflows that require them.
- Propagated frame-filter policy through DOM-settle/replay/wait paths so `waitForSettledDOM` and special replay actions honor per-agent ad/tracking frame filtering settings.
- Added per-invocation frame-filter overrides on `page.ai`, `page.perform`, and replay params so workflows can opt in/out of ad/tracking iframe filtering without constructing a new agent.
- Added per-invocation `cdpActions` overrides on task/perform/replay params so workflows can force CDP on/off without rebuilding the agent.
- Synced frame-filter policy into a11y DOM capture setup (`getA11yDOM`/`captureDOMState`) so first-attempt frame discovery uses the active task/action override instead of stale manager state.
- Hardened per-call frame-filter option reads against trap-prone parameter objects in `executeTask`, `executeTaskAsync`, and `executeSingleAction` (falls back to agent default instead of throwing).
- Hardened `waitForSettledDOM` frame-manager option setup so debug/filter configuration setter failures are isolated to sanitized warnings instead of aborting settle behavior.
- Hardened `getA11yDOM` frame-manager configuration so trap-prone `setDebug` / `setFrameFilteringEnabled` calls degrade to sanitized warnings instead of failing DOM extraction setup.
- Hardened shared runtime-context initialization so trap-prone frame-manager config setters (`setDebug`, `setFrameFilteringEnabled`) no longer abort action/task setup.
- Hardened element-locator debug logging payloads to avoid trap-prone second lookups and unbounded object dumps when frame resolution fails.
- Aligned examine-dom action instruction prompt with the actual supported method set (removed guidance implying arbitrary Playwright methods are valid).
- Replay cached-step execution now honors `cdpActions: false` by skipping CDP XPath resolution/runtime initialization and using Playwright-path action execution for that attempt.
- Normalized CLI shutdown failure logging in `cli/index.ts` to use `formatCliError`, avoiding raw unsanitized shutdown diagnostics.
- Normalized CLI per-step failure rendering in `cli/index.ts` so action error messages are sanitized/truncated via `formatCliError` before display.
- Added Anthropic structured-output regression coverage confirming multi-action calls enforce deterministic `tool_choice: { type: "any", disable_parallel_tool_use: true }`.
- Hardened CDP frame-filter host/path matching to avoid query-text false positives (e.g. unrelated URLs containing `https://yahoo.com/pixel` in query params) while preserving legitimate host-suffix + path rule matching.
- Hardened prompt token budgeting for variables by capping serialized variable entries per step-message build and emitting omitted-count context instead of unbounded variable dumps.
- Expanded trap-safe per-call override regression coverage for sync task execution and replay params to ensure `cdpActions` / `filterAdTrackingFrames` reliably fall back to agent defaults when option getters throw.
- Hardened prompt-step history materialization with trap-safe step-array reads so malformed/trap-prone `steps` payloads degrade gracefully instead of crashing message assembly.
- Hardened constructor config reads for `cdpActions` and `filterAdTrackingFrames` using trap-safe field access/fallback defaults, preventing initialization crashes from trap-prone config objects.
- Expanded cached-action helper regression coverage to validate trap-safe option access (`cdpActions`, `filterAdTrackingFrames`, `maxSteps`) with deterministic fallback to agent/default settings.
- Hardened constructor-wide config ingestion (LLM/provider/debug/options/custom-actions/local/hyper configs) with trap-safe reads and sane defaults so malformed/trap-prone config objects no longer crash initialization.
- Hardened open-tab prompt materialization with trap-safe tab-array reads so unreadable tab entries are skipped and summarized instead of collapsing to unavailable output.
- Added an additional open-tab fallback path: when the tab array becomes unreadable (e.g. trapped `length`), prompt assembly now still emits the current tab line instead of a blank/no-tabs summary.
- Added constructor regression coverage for trap-prone `llm` config getters, ensuring fallback failure paths stay deterministic and readable.
- Hardened CDP frame-filter URL normalization to support protocol-relative and scheme-less frame URLs while avoiding path-only false positives in host-based ad-domain detection.
- Refined CDP frame-filter URL normalization to correctly handle scheme-less `host:port` URLs (without misclassifying them as custom schemes), preserving ad-domain detection coverage in those cases.
- Tightened frame-filter query-signal policy so tracking query parameters are treated as strong signals only for parseable URL contexts, preventing path-only query strings from being over-filtered.
- Hardened global debug-option storage by normalizing option payloads to plain boolean fields at set-time, preventing trap-prone debug option getters from leaking into runtime reads.
- Hardened page-URL normalization option reads (fallback/maxChars) against trap-prone option objects, ensuring deterministic URL fallback/truncation behavior under malformed option payloads.
- Hardened `waitForSettledDOM` option reads for frame filtering with trap-safe accessors, so malformed/trap-prone option objects no longer break settle flow or frame-manager configuration.
- Hardened wait-listener lifecycle cleanup against trap-prone session listener-method getters, preserving settle completion while emitting sanitized detach diagnostics.
- Expanded settle-flow listener regressions to cover trap-prone `session.on` getters, ensuring timeout-based fallback remains deterministic under unreadable listener APIs.
- Aligned settle network-tracing behavior so recording-video sessions now propagate trace mode into network-idle diagnostics (including stalled-request warnings) even when debug flags are off.
- Expanded settle trace regressions with cleaner log-capture coverage to ensure recording-video trace diagnostics remain validated without noisy test output.
- Hardened settle debug-option lookup against trap-prone `getDebugOptions()` reads, with deterministic fallback trace defaults and sanitized warning diagnostics.
- Refined settle context probing to avoid noisy warnings when `page.context` is unavailable while still surfacing sanitized diagnostics for trap-prone context method/getter failures.
- Hardened Playwright CDP session initialization flow:
  - `createSession` now guards context acquisition, `newCDPSession` method reads, and session creation with bounded/sanitized diagnostics.
  - `getCDPClientForPage` now always clears pending init promises (including failed init paths) and tolerates trap-prone `page.once` close-listener attachment with sanitized warnings.
- Removed stale inline TODO/commented dead code in markdown conversion utility to keep cleanup pass consistent.
- Replaced remaining TODO-style OOPIF note in a11y DOM extraction with an accurate non-actionable implementation constraint note; `src/` now has no lingering TODO/FIXME/HACK markers.
- Hardened prompt open-tab summary fallback behavior: when context/tab enumeration is unavailable or trap-prone, prompts now fall back to the current tab line rather than opaque "Open tabs unavailable" text.
- Hardened OOPIF discovery context reads in `FrameContextManager.captureOOPIFs()`:
  - guard trap-prone `page.context`, `context.newCDPSession`, `page.frames`, and `page.mainFrame` reads,
  - short-circuit gracefully when required APIs are unavailable,
  - emit sanitized diagnostics in debug logs for getter/method trap failures.
- Refreshed stale CDP deep-dive flow notes that previously described OOPIF capture as incomplete; docs now reflect the current runtime OOPIF discovery + map-sync + multi-frame accessibility capture flow.
- Hardened HyperPage scope/context handling in `agent/index.ts`:
  - setup now uses trap-safe context/pages materialization when resolving active pages,
  - context page-listener attach/detach paths now use guarded method reads instead of direct calls,
  - preserves child-tab tracking even when context page listing getters are trap-prone.
- Hardened element-locator debug frame listing:
  - trap-prone frame arrays no longer collapse the entire debug "Available frames" payload,
  - readable frame entries are preserved even when individual frame getters/indexes trap.
- Bound CDP session creation to context receivers in both discovery paths:
  - `PlaywrightCDPClient.createSession()` now calls `newCDPSession` with the browser context receiver explicitly.
  - `FrameContextManager.captureOOPIFs()` now calls `newCDPSession` with the discovered context receiver explicitly.
  - Added regressions proving receiver-sensitive `newCDPSession` implementations continue to work.
- Hardened frame-context listener lifecycle against trap-prone session listener methods:
  - added guarded session listener attach/detach helpers in `frame-context-manager.ts` with sanitized diagnostics,
  - `ensureInitialized`, OOPIF detach wiring, `removeFrame`, and `clear` now tolerate `session.on`/`session.off` getter traps without crashing.
- Fixed frame-metadata receiver handling in element locator diagnostics:
  - `safeReadFrameText` now invokes frame `url`/`name` methods with the frame object receiver,
  - debug payloads now preserve receiver-sensitive frame metadata values instead of falling back to placeholders.
- Hardened A11y DOM option ingestion (`useCache`, `onFrameChunk`, `filterAdTrackingFrames`) with trap-safe reads, so malformed option objects no longer break extraction setup.
- Hardened A11y DOM debug-option lookup (`getDebugOptions`) with trap-safe fallback defaults and sanitized warning diagnostics.
- Hardened OpenAI/Anthropic structured-schema debug-option reads so trap-prone debug-option access no longer interrupts structured invocation paths.
- Hardened CDP Playwright adapter debug-option reads (`sessionLogging`) so trap-prone debug-option lookups degrade to sanitized warnings and safe non-logging defaults.
- Performed focused code-cleanup pass by replacing stale phase-specific TODO wording in constructor provider-selection comments with current-state guidance.
- Hardened constructor LLM validation to reject malformed non-provider/non-client `llm` payloads instead of accepting invalid runtime objects, while preserving trap-safe config reads.
- Added explicit constructor regression coverage for malformed partial `llm` objects to lock in fail-fast configuration behavior.
- Hardened prompt final-goal rendering against malformed/trap-prone task inputs by normalizing non-string goals into bounded readable diagnostics instead of throwing.
- Hardened prompt base-message materialization with trap-safe array reads so malformed/trap-prone seed message arrays no longer crash message assembly and readable entries are preserved.
- Hardened constructor custom-action ingestion with trap-safe array reads so unreadable custom-action entries are skipped while valid entries continue to register.
- Expanded top-level package exports for key workflow/config types at `@hyperbrowser/agent`.
- Removed stale script entry (`build-dom-tree-script`) and improved README usage docs.
- Added canonical single-action debug writer helper (`writePerformDebug`) while preserving deprecated alias compatibility.
