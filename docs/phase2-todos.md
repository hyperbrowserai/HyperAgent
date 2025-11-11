# Phase 2 TODOs (Derived from `docs/phase2-cdp-element-location.md`)

## Workstream A — Data & Metadata Plumbing
- [x] Extend `A11yDOMState` with `backendNodeMap: Record<EncodedId, number>`.
- [x] Update `buildBackendIdMaps` / `build-tree` to populate the map (propagate through `getA11yDOM` and cached DOM state).
- [x] Add `frameId`, `cdpSessionId`, `executionContextId` fields to `IframeInfo`; ensure `getA11yDOM` / frame extraction layers fill them in.
- [x] `resolveFrameSession(frameIndex)` helper returning `{ frameId, session: CDPSession }`.
- [x] Create `src/cdp/element-resolver.ts`:
  - `resolveElement(encodedId, ctx)` that maps encoded IDs → frame/session → backend node.
  - Caches node/object IDs for reuse.
  - `describeElement(resolved)` for diagnostics.

## Workstream B — Frame-First Resolver Enhancements
- [ ] Ensure encoded ID decoding goes through the new `frameIndexMap` (Phase 3) / FrameGraph.
- [x] Implement frame-scoped XPath fallback:
  - If backend node missing, run `DOM.getDocument` + XPath inside the frame session to recover it.
  - Update `backendNodeMap` cache accordingly.
- [ ] Define `{ frameIndex, selector }` structure for focus selectors and any manual inputs.

## Workstream C — CDP Interaction Layer
- [x] Flesh out `src/cdp/interactions.ts`:
  - `clickElement`, `typeText`, `setValue`, `pressKey`, `scrollElement`, etc., powered by CDP scroll/keyboard/mouse primitives.
- [x] Add `dispatchCDPAction(method, args, ctx)` shim so `act-element` / `executeSingleAction` can invoke actions generically.
- [x] Bounding box strategy:
  - Visual/debug mode: reuse injected bounding box data when provided.
  - Default mode: lazily call `DOM.getContentQuads` (falling back to injected script only when requested).

## Workstream D — Snapshot Optimization
- [ ] Implement snapshot diffing between steps (cache `combinedTree` hashes, compute diff chunks).
- [ ] Support focus selectors `{ frameIndex, selector }` to limit DOM extraction when provided.

## Workstream E — Wiring Agent Actions
- [x] Replace `getElementLocator` usage with the new `resolveElement`.
- [x] Swap `executePlaywrightMethod` with `executeCDPAction` inside `act-element` and `executeSingleAction` (when `cdpActions` flag on).
- [x] Extend `ActionContext` with CDP helpers (`resolveElement`, `executeAction`, `getBoundingBox`, `waitForDomIdle`).
- [x] Ensure `examineDom` continues to emit encoded IDs + metadata without change.

## Workstream F — Testing & Rollout
- [ ] Unit tests: element resolver, interaction helpers.
- [ ] Integration scripts: run `scripts/test-page-ai.ts` / `scripts/test-page-iframes.ts` with `CDP_MODE=1`.
- [ ] Feature flag: `cdpActions` off by default; provide config path to enable for `page.aiAction` first.
