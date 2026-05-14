# Repository Guidelines

## Project Structure & Module Organization
- `src/` is the source of truth. `agent/` orchestrates the runtime loop (`tools/agent.ts`), with `shared/` housing DOM capture/runtime utilities and element finding, `examine-dom/` powering `page.perform` (and deprecated `page.aiAction`), `messages/` building prompts, `mcp/` hosting the MCP client, and `error.ts` centralizing agent errors; `debug/options.ts` controls low-level tracing.
- `cdp/` wraps Chrome DevTools (client lifecycle, frame graph/context tracking, element resolution, bounding boxes, and action dispatch). `performAction` prefers these CDP paths and falls back to Playwright helpers when disabled.
- `context-providers/a11y-dom/` is the single DOM provider (accessibility tree + encoded IDs, optional bounding boxes/visual overlays, DOM snapshot cache, streaming). Keep overlay generation (`visual-overlay.ts`) and ID maps (`build-maps.ts`, `dom-cache.ts`) aligned when changing extraction logic. Shared overlay/screenshot helpers live in `context-providers/shared/`.
- `browser-providers/` implement `LocalBrowserProvider` (Playwright `chromium` channel "chrome" with stealth flags), `HyperbrowserProvider`, and `RemoteChromeProvider`; extend these instead of launching browsers directly. Base class is in `types/browser-providers/types.ts`.
- `llm/` houses native adapters (`openai`, `anthropic`, `gemini`, `deepseek`) plus schema/message converters—use `createLLMClient` and update `providers/index.ts` for new backends.
- `types/` centralizes config, browser provider, agent state/action definitions (including `cdpActions`, visual/streaming/cache flags). Add interfaces here before wiring features elsewhere.
- `utils/` collects shared helpers (`ErrorEmitter`, retry/sleep, markdown conversion, DOM settle logic); prefer reuse over reimplementation.
- `custom-actions/` is the extension point for domain-specific capabilities; register via `HyperAgentConfig.customActions` and avoid the reserved `complete` action type.
- `cli/` powers the CLI entrypoint (`src/cli/index.ts`); repo `index.ts` is the package entry.
- `scripts/` holds ts-node smoke probes and integration harnesses (`test-page-ai.ts`, `test-async.ts`, `test-page-iframes.ts`, `run-webvoyager-eval.ts`, etc.).
- `examples/`, `docs/`, and `assets/` provide reference flows and media—update alongside API or UX changes. `currentState.md` should mirror major architectural shifts.
- `evals/` stores baseline datasets; do not hand-edit generated outputs. `dist/` and `cli.sh` are generated—modify source, then run `yarn build` rather than editing them directly.

## Directory-Scoped AGENTS Files
- Additional `AGENTS.md` files exist in key subdirectories (`src/`, `src/agent/`, `src/cdp/`, `src/context-providers/`, `src/browser-providers/`, `src/llm/`, `src/types/`, `src/utils/`, `src/cli/`, `src/custom-actions/`, `src/debug/`, `scripts/`, `examples/`, `docs/`, `evals/`, and `assets/`).
- Apply root guidance everywhere, then apply the nearest directory `AGENTS.md` for local constraints.
- Subdirectory files are additive and should refine local implementation details without contradicting root policy.

## Build, Test, and Development Commands
- `yarn build` wipes `dist/`, runs `tsc` + `tsc-alias`, and restores executable bits on `dist/cli/index.js` and `cli.sh`; run before publishing or cutting releases.
- `yarn lint` / `yarn format` use the flat ESLint config (`eslint.config.mjs`) and Prettier over `src/**/*.ts`; fix warnings instead of suppressing rules.
- `yarn test` launches Jest; set `CI=true` for coverage and deterministic snapshots.
- `yarn cli -c "..." [--debug --hyperbrowser --remote-chrome <wsEndpoint> --mcp <path>]` runs the agent; `--hyperbrowser` switches to the Hyperbrowser provider, `--remote-chrome <wsEndpoint>` connects to a remote Chrome instance, and `--debug` drops artifacts into `debug/`.
- `yarn example <path>` (backed by `ts-node -r tsconfig-paths/register`) is the quickest way to execute flows in `examples/` or `scripts/`.
- DOM metadata builds at runtime via the a11y provider; the legacy `build-dom-tree-script` entry points at a removed file—avoid relying on it until refreshed.

## Agent Runtime & Integrations
- The agent loop (`agent/tools/agent.ts`) captures the accessibility tree via `captureDOMState` (text-first, optional streaming and snapshot cache). Visual overlays/screenshots are opt-in (`enableVisualMode`) and composited with CDP screenshots for `page.ai`.
- DOM snapshots use encoded IDs (`frameIndex-backendNodeId`) and cache for ~1s when `useDomCache` is true; navigation events and actions call `markDomSnapshotDirty` to invalidate. Ensure new actions mutate the cache appropriately.
- Default actions live in `agent/actions/index.ts`: `goToUrl`, `refreshPage`, `actElement` (unified element action constrained by `AGENT_ELEMENT_ACTIONS`), `extract`, `wait`, plus `pdf` when `GEMINI_API_KEY` is present. `complete` variants are injected by the runtime and cannot be registered manually.
- Element execution is CDP-first (`cdp/resolveElement` + `dispatchCDPAction`); it falls back to Playwright locators when `cdpActions` is false or backend maps are missing. Keep frame graph/bounding-box expectations aligned with `context-providers/a11y-dom` when tweaking extraction.
- `page.perform` (and the deprecated `page.aiAction` alias) uses the `examine-dom/` flow for single actions: accessibility tree → LLM element ranking → `performAction`. It always runs in a11y mode (no screenshots) and shares the same allowed methods as `actElement`.
- Action caching is available on `HyperPage` (`getActionCache`, `runFromActionCache`) and implemented in `agent/shared/action-cache*` + `run-cached-action`; keep replays aligned with `actElement` and DOM cache invalidation.
- MCP integrations live in `agent/mcp/client.ts`; `initializeMCPClient`/`connectToMCPServer` register remote tools as actions. Guard optional dependencies and remember `complete` is reserved.
- Debugging: pass `debug: true` or `debugOptions` to surface CDP sessions, DOM-capture profiling, and wait tracing; artifacts land under `debug/<taskId>` when enabled.

## Coding Style & Naming Conventions
- Strict TypeScript is enforced; keep explicit return types and narrow unions for agent state and CDP action types.
- Do not use `any`. Define interfaces in `src/types` (prefer `interface`), reuse shared types (`A11yDOMState`, `EncodedId`, CDP action enums) instead of ad-hoc objects. `HyperVariable.description` is required—supply meaningful text.
- Rely on Prettier defaults (2-space indent, double quotes, trailing commas) and ESLint autofix; avoid manual formatting.
- Classes/interfaces use `PascalCase`, functions and variables use `camelCase`, environment constants use `UPPER_SNAKE_CASE`.
- Import internal modules through `@/*` aliases (and `@/cdp` for DevTools helpers) to avoid brittle relative paths.
- Use zod schemas when handling LLM output or user input (see `examine-dom/schema.ts`, `agent/actions`).

## Testing Guidelines
- Place `*.test.ts` beside the code they cover or under `src/__tests__/`; mock browsers/CDP (`getCDPClient`, `resolveElement`) for unit tests unless running integration probes in `scripts/`.
- Ensure new behavior has unit coverage plus a smoke scenario if it touches agent flows, DOM capture, or the CLI. Existing probes include `scripts/test-page-ai.ts`, `test-async.ts`, `test-page-iframes.ts`, and `test-variables.ts`.
- Run `yarn test` before pushing and capture flaky seeds in the PR description. Use `scripts/run-webvoyager-eval.ts` or other `test-*.ts` probes for regression checks; record the command and seed/output in PR notes.

## Commit & Pull Request Guidelines
- Follow the short imperative subject style (`Fix DOM capture retry`, `Wire CDP frame graph`), and reference issues as `(#123)`.
- Squash temporary commits prior to merge; leave feature flags or TODOs documented.
- PRs must explain intent, list validation commands, and attach screenshots or terminal captures for user-visible changes. Call out impacts to browser providers, MCP integrations, DOM capture, or LLM adapters explicitly.
- Request review from domain owners (agent/context/CLI) and wait for CI green before merging. For browser provider or CDP changes, highlight any required infrastructure updates.
