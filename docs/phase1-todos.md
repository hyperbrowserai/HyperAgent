# Phase 1 TODOs (Derived from `docs/phase1-generic-cdp-plan.md`)

## Workstream A — CDP Core
- [x] Scaffold `src/cdp/types.ts` (`CDPSession`, `CDPClient`, `CDPFrameHandle`, `CDPTargetDescriptor`).
- [x] Implement `src/cdp/playwright-adapter.ts`:
  - [x] Wrap `Page.context().newCDPSession` calls, cache sessions per page.
  - [x] Expose helpers (`getCDPClient`, `getCDPSession`) used by DOM capture, screenshots, etc.
- [x] Update all existing CDP call sites (`getA11yDOM`, `waitForSettledDOM`, screenshot helpers, extract action) to go through the adapter/cache.
- [x] Ensure `HyperAgent.closeAgent()` disposes cached clients and handles page close events gracefully.

## Workstream B — CDP Transport & Session Multiplexer
- [x] Implement `CdpConnection` (`src/cdp/connection.ts`) with:
  - [x] WebSocket connect/close + inflight request tracking.
  - [x] `Target.setAutoAttach`, `Target.setDiscoverTargets`, attach/detach handling.
  - [x] Session registry (`sessionId → CDPSession`) plus event routing.
- [x] Expose `attachToTarget`, `getTargets`, `onTransportClosed`.
- [ ] Unit tests: mock WebSocket, verify request routing and auto-attach logic.
- [ ] Integration smoke test: connect to local Chrome, log attached targets.

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
- [ ] Capture verification commands (unit + smoke) for the eventual PR checklist.
