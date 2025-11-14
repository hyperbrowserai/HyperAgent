# Phase 1 TODOs (Derived from `docs/phase1-generic-cdp-plan.md`)

## Workstream A — CDP Core
- [x] Scaffold `src/cdp/types.ts` (`CDPSession`, `CDPClient`, `CDPFrameHandle`, `CDPTargetDescriptor`).
- [x] Implement `src/cdp/playwright-adapter.ts`:
  - [x] Wrap `Page.context().newCDPSession` calls, cache sessions per page.
  - [x] Expose helpers (`getCDPClient`, `getCDPSession`) used by DOM capture, screenshots, etc.
- [x] Update all existing CDP call sites (`getA11yDOM`, `waitForSettledDOM`, screenshot helpers, extract action) to go through the adapter/cache.
- [x] Ensure `HyperAgent.closeAgent()` disposes cached clients and handles page close events gracefully.

## Workstream B — CDP Transport & Session Multiplexer
- ❌ **Deprecated:** We removed the standalone `CdpConnection` implementation because the current stack reuses Playwright's private CDP session IDs. The remaining transport responsibilities now live in `playwright-adapter.ts` and the frame/context managers.

## Workstream C — Script Injection Manager
- [x] Build `src/cdp/script-injector.ts`:
  - [x] Cache injections per `(sessionId, scriptKey)`.
  - [x] Install scripts via `Page.addScriptToEvaluateOnNewDocument` + immediate `Runtime.evaluate`.
- [x] Bounding box helper:
  - [x] Port/inject bounding-box collector script via CDP sessions.
  - [x] Provide `getBoundingBox(encodedId)` API backed by injected data, falling back to `DOM.getContentQuads` when unavailable.
- [ ] Tests ensuring scripts are injected exactly once per session and re-installed after navigation/session recreation (optional / deferred).

## Workstream D — Connector Prep
- [x] Document `ConnectorConfig` types (Playwright) without wiring them yet.
- [x] Add guardrails in code comments noting the provider layer is legacy and will be replaced by connectors.
- [x] Note the future `attachDriverToCDP({ wsEndpoint, connectWith })` helper but defer implementation until Phase 4.

## Cross-Cutting
- [x] Update README/architecture notes referencing the new CDP modules once implemented.
- [x] Smoke verification (basic script runs) performed; still need to document commands in future PRs.
