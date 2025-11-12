# Phase 3 TODOs (Derived from `docs/phase3-cdp-frame-management.md`)

## Workstream A — FrameGraph & Execution Contexts
- [ ] Implement `FrameGraph` module (`src/cdp/frame-graph.ts`) with `FrameRecord`, `FrameGraph`, and helper mutators.
- [ ] Bootstrap FrameGraph on startup using `Page.getFrameTree`, `Target.getTargets`, and `DOM.getFrameOwner` to capture `backendNodeId` and parent relationships.
- [ ] Maintain `frameIndexMap` (encoded frame index ↔ CDP `frameId`) for backward compatibility with `EncodedId`.
- [ ] Build `ExecutionContextRegistry` listening to `Runtime.executionContextCreated/Destroyed` per session; expose `waitForMainWorld(frameId)`.
- [ ] Introduce a `FrameContextManager` class that owns the FrameGraph + ExecutionContextRegistry and exposes high-level APIs (`getFrameRecord`, `ensureSession`, `waitForMainWorld`), so the rest of the code depends on the abstraction rather than raw CDP plumbing.

## Workstream B — CDP Session Manager
- [ ] Extend the Phase 1 CDP client to call `Target.setAutoAttach({ autoAttach: true, flatten: true })` and cache `sessionId → CDPSession`.
- [ ] Track `frameId → CDPSession` and react to `Target.attachedToTarget` / `detachedFromTarget` / `Page.frameAttached` events to keep the FrameGraph in sync.
- [ ] Provide `ensureFrameSession(frameId)` that waits for (or creates) the session, reusing pending promises to avoid races.
- [ ] Treat the session manager as part of the `FrameContextManager` abstraction (dependency inversion): higher layers (resolver, DOM extraction) should only interact with the manager, not with raw Playwright handles or CDP commands.

## Workstream C — Resolver & DOM Utilities
- [ ] Update `resolveElement` / `resolveFrameSession` to fetch sessions/contexts through the FrameGraph manager (no Playwright frame handles).
- [ ] Add `resolveFrame(frameIndexOrId)` and `resolveFrameOwner(encodedId)` helpers backed by the FrameGraph.
- [ ] Replace XPath-based frame traversal (`resolveFrameByXPath`, Playwright frame lookups) with the CDP frame registry in DOM extraction helpers.

## Workstream D — DOM Extraction & Actions
- [ ] Refactor `getA11yDOM` to iterate frames via FrameGraph sessions instead of Playwright `page.frames()`.
- [ ] Populate `frameMap` with new metadata (`frameId`, `sessionId`, `executionContextId`, `backendNodeId`, `iframeEncodedId`).
- [ ] Update `act-element` / `executeSingleAction` to resolve frame sessions/contexts via the registry before dispatching CDP actions; include frame graph snapshots in debug artifacts.

## Workstream E — Lifecycle Watcher & Wait Helpers
- [ ] Implement a `LifecycleWatcher` (mirroring Playwright semantics) listening to `Page.frameNavigated`, `Page.frameDetached`, network idle, etc.
- [ ] Expose `waitForLifecycle(frameId, { waitUntil })` and `waitForDomNetworkQuiet` utilities to replace `waitForSettledDOM` in later phases.
- [ ] Unit tests for watcher behavior (navigations, redirects, aborted loads).

## Workstream F — Testing & Docs
- [ ] Unit tests for FrameGraph, session manager, execution context registry, and resolver edge cases.
- [ ] Integration pass: run iframe-heavy templates (YouTube OOPIF, Google Maps) using the new frame registry to confirm parity.
- [ ] Update docs/debug output to describe the new frame tracking approach (`frame-graph.json`, logging).
