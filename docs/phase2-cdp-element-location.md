# Phase 2 Plan: CDP-Only Element Location & Interaction

Objective: Eliminate XPath/Playwright locators for agent actions by using Chrome DevTools Protocol (CDP) primitives exclusively. This unlocks browser-agnostic control (Playwright & Puppeteer) and sets the stage for connector-based sessions.

Scope maps to integration roadmap Phase 2 (items 2.1–2.2).

---

## 1. Current State Recap
- `examineDom` returns encoded IDs that map to XPath strings via `ctx.domState.xpathMap`.
- `getElementLocator` ( `src/agent/shared/element-locator.ts` ) converts encoded IDs -> XPath -> Playwright `Locator`.
- Actions (`act-element`, `executeSingleAction`, etc.) call `executePlaywrightMethod`, so all interactions run through Playwright.
- CDP metadata already exists in `A11y` extraction: accessibility nodes include `backendDOMNodeId`, but we do not persist an explicit map or expose CDP handles.
- CDP is only used today for screenshots, DOM settling, and AX tree capture.

Pain points:
1. XPath is brittle and Playwright-only.
2. Element resolution jumps through multiple abstractions (LLM → encodedId → XPath → Locator), making debugging hard.
3. Frame handling depends on Playwright frame references; CDP IDs are unused.

---

## 2. Desired Architecture
1. **Element lookup** remains XPath-first for human-readable metadata (`xpathMap` stays the canonical description), but resolution ultimately uses CDP `DOM.resolveNode` / `DOM.describeNode` keyed by `backendNodeId` derived from that XPath.
2. **Frame-aware resolution** chooses the correct CDP session (main vs OOPIF) using frame metadata, without Playwright frame traversal.
3. **Element interactions** call CDP `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `DOM.setAttributeValue`, or `Runtime.callFunctionOn`.
4. **Playwright path is removed** whenever the `cdpActions` flag is on—no fallback. We keep XPath metadata for explainability, but resolution always goes through CDP.

---

## 3. Workstream A — Data & Metadata Plumbing

### A1. Backend Node Map
- Add `backendNodeMap: Record<EncodedId, number>` to `A11yDOMState`.
- Populate it inside `buildBackendIdMaps` / `build-tree` when we already know `backendDOMNodeId`.
- Store the map in `ctx.domState` so actions have direct access.

### A2. Frame Session Registry
- Extend `IframeInfo` to include:
  ```ts
  interface IframeInfo {
    frameId?: string;
    cdpSessionId?: string;
    executionContextId?: number;
    openerFrameId?: string | null;
  }
  ```
- While extracting AX trees:
  - For OOPIF frames, record the CDP session ID returned by Playwright’s `newCDPSession(frame)`.
  - For same-origin frames, the main session handles CDP calls; store the frameId returned by `Page.getFrameTree`.
- Build helper `resolveFrameSession(frameIndex)` that returns `{ session: CDPSession, frameId }`.

### A3. CDP Element Resolver Module
- Create `src/cdp/element-resolver.ts` with:
  ```ts
  export interface ResolvedCDPElement {
    session: CDPSession;
    frameId: string;
    backendNodeId: number;
    nodeId?: number;
    objectId?: string;
  }
  export async function resolveElement(encodedId: EncodedId, ctx: ElementResolveContext): Promise<ResolvedCDPElement>
  ```
- `ElementResolveContext` includes the `backendNodeMap`, `frameMap`, and `CDPClient`.
- Implementation steps:
  1. Parse `frameIndex` from encodedId.
  2. Look up `backendNodeId`.
  3. Use `resolveFrameSession(frameIndex)` to get the right CDP session.
  4. Call `DOM.resolveNode` with `{ backendNodeId }`.
  5. Cache `{ nodeId, objectId }` per encodedId for subsequent interactions.

### A4. Node Verification Utilities
- Add helper `describeElement(resolved)` that calls `DOM.describeNode` to fetch tag name, attributes, bounding box (if needed).
- Provide `querySelector` utilities as follow-ups for Phase 6 (frame traversal), but keep basic resolution lean.

Deliverables:
- `backendNodeMap` plumbing.
- `resolveFrameSession` helper.
- `element-resolver.ts` with caching.

---
## 4. Workstream B — Frame-First Resolver Enhancements

Instead of exposing user-facing deep-locator syntax, the agent always works “frame first.” Encoded IDs carry the frame ordinal, and we resolve everything through the FrameGraph + CDP metadata.

### B1. Encoded ID Decoding
1. Given `encodedId = "${frameIndex}-${backendNodeId}"`, look up the frameId via the Phase 3 FrameGraph (`frameIndexMap`).
2. Fetch the owning `CDPSession`, execution context, and cached backend node data for that frame.
3. If backend node metadata is missing (e.g., DOM refreshed), fall back to the stored XPath *within that frame only*, rebuilding `backendNodeId` via `DOM.resolveNode` scoped to the frame’s session.

### B2. Frame-Scoped XPath Fallbacks
1. Maintain per-frame XPath maps (already returned by `getA11yDOM`).
2. When resolving a stale element:
   - Use the frame’s `DOM.getDocument` + XPath to re-find the DOM node.
   - Update the backend node cache and proceed with CDP interactions.
3. No cross-frame hop parsing is exposed externally; all logic stays internal and frame-scoped.

### B3. Selector Inputs for Config/Focus
- When configuration needs a “focus selector” (e.g., to scope DOM snapshots), require callers to specify the frame index/ordinal plus a selector relative to that frame. Example:
  ```json
  { "frameIndex": 3, "selector": "#checkout-button" }
  ```
- Provide helper utilities that, given `{ frameIndex, selector }`, resolve the frame via the graph and run a standard CSS/XPath query within that frame’s CDP session.

### B4. Tests
- Unit tests for encodedId → frameId lookup, frame-scoped XPath fallback, and focus selector resolution.
- Integration tests ensuring stale elements re-resolve correctly after frame navigations without exposing hop syntax.

## 5. Workstream C — CDP Interaction Layer

### C1. CDP Interaction API
- Create `src/cdp/interactions.ts` with explicit contracts (TypeScript interfaces):
  ```ts
  export interface CDPActionContext {
    session: CDPSession;
    element: ResolvedCDPElement;
    encodedId: EncodedId;
    boundingBoxProvider: (id: EncodedId) => DOMRect | undefined;
  }

  export type CDPActionMethod =
    | "click"
    | "fill"
    | "type"
    | "press"
    | "scrollTo"
    | "nextChunk"
    | "prevChunk"
    | "hover"
    | "check"
    | "uncheck"
    | "selectOptionFromDropdown";
  ```
- API surface:
  - `clickElement(ctx: CDPActionContext, options?: { button?: "left" | "right" | "middle"; clickCount?: 1 | 2 }): Promise<void>`
    - Default path: resolve `objectId`, scroll into view, call `DOM.getContentQuads` (or `DOM.getBoxModel`) to compute a center per interaction.
    - When visual/debug mode pre-injected the bounding-box script for this session, reuse that cached data instead of issuing `DOM.*`.
    - Send `Input.dispatchMouseEvent` for move/press/release with precise coordinates.
  - `typeText(ctx, text: string, opts?: { delayMs?: number; commitEnter?: boolean }): Promise<void>`
    - Focus element via `Runtime.callFunctionOn`.
    - Use `Input.insertText` to enter characters; optionally append `Enter`.
  - `setValue(ctx, value: string): Promise<void>`
    - Execute DOM script on the element to set `.value`, then dispatch `input`/`change`.
  - `pressKey(ctx, key: string): Promise<void>`
    - Map to `Input.dispatchKeyEvent` for keydown/keyup.
  - `scrollElement(ctx, target: ScrollTarget): Promise<void>`
    - For `scrollTo` percentages, execute DOM script calling `element.scrollTo`.
    - For `nextChunk`/`prevChunk`, use bounding box height to compute deltas.
- Provide `dispatchCDPAction(method: CDPActionMethod, args: unknown[], ctx: CDPActionContext)` so existing action definitions simply pass through their method strings.

### C2. Action Coverage (Parity with Stagehand Locator)
Cover the full action set currently routed through Playwright:
1. **Pointer actions**: click, doubleClick, hover, dragAndDrop, mouse.wheel (`Input.dispatchMouseEvent` with `deltaX/Y`).
2. **Typing/fill**: `fill`, `type`, `press` using `Runtime.callFunctionOn` + `Input.insertText/dispatchKeyEvent`.
3. **Scrolling**: `scrollTo`, `scrollIntoView`, `scrollByPixelOffset`, `nextChunk`, `prevChunk`.
4. **Form controls**: `selectOption`, `check`, `uncheck`, `setInputFiles`.
5. **Advanced**: `sendClickEvent` (direct DOM event), `highlightElement` (Overlay API), `scrollIntoViewIfNeeded`.

Each helper should:
- Resolve `objectId` lazily via `resolveNode`.
- Scroll into view (`DOM.scrollIntoViewIfNeeded`) before pointer input.
- Release remote objects (`Runtime.releaseObject`) even on failure.
- Normalize arguments (e.g., percent strings for scroll).

### C3. Bounding Box Strategy
- When `cdpActions` and visual/debug mode are enabled, capture bounding boxes during DOM extraction and reuse them for all interactions.
- In the default (non-visual) mode, compute bounding boxes lazily per action via `DOM.getContentQuads` / `DOM.getBoxModel`; no upfront injection required.
- Share helpers so click/scroll actions can transparently pick the available data source without duplicating geometry logic.

### C4. Keyboard Input
- Implement `pressKey` using `Input.dispatchKeyEvent` for keyDown/keyUp combos, mirroring Playwright’s behavior (respecting modifiers).
- Support text entry via `Input.insertText` for printable strings.

---
## 6. Workstream D — Snapshot Optimization

### D1. Snapshot Diffing
- After each DOM capture, cache the `combinedTree` (compressed/hased).
- On the next step, compute a diff (line-based or chunk-based). If the diff is below a configurable size threshold, send only the diff to the LLM; otherwise send the full tree.
- Record metrics about diff coverage to monitor effectiveness.

### D2. Focus Selectors
- Accept `{ frameIndex, selector }` tuples (as described in Workstream B) to limit output to a specific frame/subtree.
- Resolve the selector only within the specified frame; if omitted, default to the main frame’s full tree.

### D3. Tests
- Unit tests ensuring diff utility produces expected output and falls back when empty.
- Integration tests showing a second DOM capture sends diff-only data when small changes occur.

## 7. Workstream E — Wiring Agent Actions

### E1. Replace `getElementLocator`
- Deprecate `getElementLocator` in favor of `resolveElement`.
- Keep the existing file but re-export the new resolver for backwards compatibility until removal.
- Update `act-element`, `executeSingleAction`, and any helper relying on `getElementLocator` to use the CDP resolver.

### E2. Swap `executePlaywrightMethod`
- Introduce `executeCDPAction(method, args, resolvedElement, options)` mirroring the signature of `executePlaywrightMethod`.
- `act-element` and `executeSingleAction` call the new CDP executor exclusively when `cdpActions` is enabled.
- No Playwright fallback—fail fast if CDP interaction errors so we can fix issues directly.

### E3. Update ActionContext
- Extend `ActionContext` to include `cdpClient` and `cdpCache`.
- Ensure `runAgentTask` populates the CDP client from Phase 1’s cache before invoking actions.

### E4. ExamineDom Compatibility
- No changes to `examineDom`; it still returns encoded IDs.
- Document the expectation that encoded IDs map cleanly to backend node IDs; add validation that throws if `backendNodeMap` is missing entries (so we catch extraction bugs early).

---

## 8. Testing & Validation

### T1. Unit Tests
- `element-resolver.test.ts`: verify `resolveElement` chooses the right session, caches node/object IDs, and throws on missing backend nodes.
- `interactions.test.ts`: mock CDP session (`send` calls) to ensure click/type/scroll issue proper commands.

### T2. Integration Tests
- Extend `scripts/test-page-ai.ts` and `scripts/test-page-iframes.ts` to run once with `CDP_MODE=1` (new flag) and assert actions succeed without Playwright locators.
- Add a regression script exercising common actions (click, type, select, scroll) across main-frame and iframe pages.

### T3. Debugging Aids
- Log CDP command summaries when `debug` is true (`[CDPAction] clickElement → Input.dispatchMouseEvent ...`).
- Capture resolved element metadata (frameId, backendNodeId) in debug artifacts alongside existing DOM snapshots.

---

## 9. Rollout Strategy
1. **Feature flag**: introduce `cdpActions?: boolean` in config/environment. Default `false` initially.
2. **Shadow mode**: when flag disabled, we may still populate CDP caches for telemetry but continue executing via Playwright.
3. **Gradual enablement**: turn on CDP actions for `page.aiAction` first (single-step), then the multi-step agent loop.
4. **Permanent switch**: once CDP mode is considered stable, delete `executePlaywrightMethod` and related XPath execution paths.

---

## 10. Deliverables Checklist
- [ ] `backendNodeMap` added to DOM state + populated.
- [ ] `resolveFrameSession` helper & CDP session tracking enhancements.
- [ ] `src/cdp/element-resolver.ts` + caching layer.
- [ ] `src/cdp/interactions.ts` covering click, type, setValue, scroll, keyPress.
- [ ] `executeCDPAction` wired into `act-element`, `executeSingleAction`, and other callers.
- [ ] Feature flag + tests (unit + integration) verifying CDP-only flows.
- [ ] Debug logging/documentation for the new CDP path.

This plan completes Phase 2 by making element targeting and interaction entirely CDP-driven, enabling true browser-agnostic execution ahead of the connector rollout.
