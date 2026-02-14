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
- Expanded top-level package exports for key workflow/config types at `@hyperbrowser/agent`.
- Removed stale script entry (`build-dom-tree-script`) and improved README usage docs.
- Added canonical single-action debug writer helper (`writePerformDebug`) while preserving deprecated alias compatibility.
