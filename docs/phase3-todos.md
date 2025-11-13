# Phase 3 TODOs (Derived from `docs/phase3-cdp-frame-management.md`)

## Workstream A — FrameGraph & Execution Contexts
- [x] Implemented `FrameGraph` + helper mutators (`src/cdp/frame-graph.ts`).
- [x] Bootstrapped the graph via `FrameContextManager.captureFrameTree` (`Page.getFrameTree` + `DOM.getFrameOwner`).
- [x] Maintain `frameIndexMap` (encoded frame index ↔ CDP `frameId`).
- [x] Track execution contexts via `FrameContextManager` (`Runtime.executionContextCreated/Destroyed`) with `waitForExecutionContext` helper.
- [x] `FrameContextManager` now owns frame metadata + context/session registry.

## Workstream B — CDP Session Manager
- [x] Auto-attach enabled via `FrameContextManager.enableAutoAttach()`.
- [x] `Target.attachedToTarget` + `Page.frameAttached/Detached/Navigated` now update the graph and session map.
- [x] `resolveElement` / DOM extraction call `frameManager.getFrameSession` instead of spinning up Playwright sessions.
- [x] Higher layers depend on the manager abstraction only (no raw `newCDPSession`).

## Workstream C — Resolver & DOM Utilities
- [x] `resolveElement` now reuses manager sessions and falls back to root when needed.
- [x] DOM helpers pull frame metadata from the manager (no cached `playwrightFrame`).
- [ ] Remove legacy Playwright fallback (`resolveFrameByXPath`, `agent/shared/element-locator.ts`) once CDP-only flow proves stable.

## Workstream D — DOM Extraction & Actions
- [x] `getA11yDOM` fetches iframe trees via CDP sessions (no Playwright frame traversal).
- [x] `frameMap` now includes frameId/session/executionContext metadata and stays in sync via auto-attach.
- [x] Actions use the resolver/manager (`resolveElement` + CDP interactions). Debug output now logs frame/session info.

## Workstream E — Lifecycle Watcher & Wait Helpers
- [x] Lifecycle events wired into `FrameContextManager` (frame attach/detach/navigate + execution contexts).
- [x] `waitForSettledDOM` now delegates to `waitForLifecycle` + network-idle helper.
- [ ] Add targeted tests and eventually rename/remove the `waitForSettledDOM` alias.

## Workstream F — Testing & Docs
- [ ] Add basic coverage for frame/session/lifecycle watcher behavior (pending).
- [x] Manual integration pass (iframe, YouTube OOPIF, Google Maps) verified via logs.
- [ ] Update docs (this file, connection plan) to describe the auto-attach/lifecycle architecture (in progress).
