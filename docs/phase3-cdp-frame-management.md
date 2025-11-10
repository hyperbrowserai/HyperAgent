# Phase 3 Plan: Pure CDP Frame Management

Objective: Make CDP the single source of truth for frame discovery, metadata, and session management—eliminating XPath-based frame traversal and Playwright frame handles. This unlocks consistent behavior across same-origin iframes, cross-origin OOPIFs, and future connector-driven sessions.

Scope aligns with integration roadmap Phase 3 (items 3.1–3.3 & 6.1–6.2).

---

## 1. Current Gaps
- `IframeInfo` stores limited data (xpath, sibling index, optional Playwright frame reference); no CDP session/execution context IDs.
- Same-origin frames are resolved lazily via XPath (`resolveFrameByXPath`), which relies on Playwright `Frame` handles.
- OOPIF sessions exist, but they are transient and not tracked centrally; each extraction step re-attaches.
- Frame lifecycle events (`frameAttached`, `frameDetached`, etc.) aren’t consumed, so the agent lacks real-time updates.
- `frameMap` uses incrementing indices that don’t align with CDP `frameId`s, making cross-referencing hard.

---

## 2. Desired Architecture
1. **Frame registry** keyed by CDP `frameId`, storing:
   - `frameId`, `parentFrameId`, `loaderId`, URL, name.
   - `cdpSessionId`, `executionContextId`, `isolatedWorldId`.
   - `backendNodeId` for the `<iframe>` element (via `DOM.getFrameOwner`).
   - Optional driver references (Playwright/Puppeteer) for debugging only.
2. **Session manager** that:
   - Uses `Target.setAutoAttach` to capture OOPIFs.
   - Keeps a mapping of `frameId → CDPSession`.
   - Detaches sessions when frames disappear.
3. **Frame tree builder** that:
   - Calls `Page.getFrameTree` to bootstrap all frames.
   - Uses `Target.getTargets` to discover OOPIF targets not in the initial tree.
   - Reconciles data into a normalized `FrameGraph`.
4. **Resolver APIs**:
   - `resolveFrame(frameIndex | frameId)` returns a struct with session/context IDs and DOM metadata.
   - `attachToFrame(frameId)` ensures there is an active session/context for a frame before DOM or interaction work.
5. **Event-driven updates** so the registry stays current across navigations and dynamic iframe insertions.

---

## 3. Workstream A — Frame Discovery & Metadata

### A1. FrameGraph Structure
Create `src/cdp/frame-graph.ts`:
```ts
export interface FrameRecord {
  frameId: string;
  parentFrameId: string | null;
  loaderId?: string;
  name?: string;
  url?: string;
  sessionId?: string;
  executionContextId?: number;
  isolatedWorldId?: number;
  backendNodeId?: number;
  iframeEncodedId?: EncodedId;
  lastUpdated: number;
}

export interface FrameGraph {
  frames: Map<string, FrameRecord>;
  children: Map<string | null, string[]>;
  frameIndexMap: Map<number, string>; // encoded frameIndex -> frameId
}
```
- Maintain `frameId ↔ encoded frame index` mapping for backwards compatibility during transition (`EncodedId`’s first segment can reference the new indices).
- Provide helpers: `addFrame`, `updateFrame`, `removeFrame`, `getAncestors`.
- Handle root swaps: when a main frame is replaced (no `parentId`), rename the existing root frameId to keep ordinal semantics, mirroring CDP’s behavior.
- Store `ownerBackendNodeId` for each child so absolute iframe XPaths can be built quickly.

### A2. Bootstrap
- When initializing DOM extraction (Phase 1 `getA11yDOM`), call:
  1. `Page.getFrameTree` to get the full hierarchy (same-origin + placeholders for OOPIF).
  2. `Target.getTargets` to fetch current targets; filter `type === "iframe"` or `page` with `subtype === "iframe"`.
  3. Stitch results into the `FrameGraph`, ensuring each CDP `frameId` is represented.
- For each frame, call `DOM.getFrameOwner({ frameId })` to retrieve `backendNodeId` of the `<iframe>` element; store it in `FrameRecord.backendNodeId` and derive `iframeEncodedId`.
- Assign deterministic ordinals per frameId (0 = main frame). Maintain `frameIndexMap` so encoded IDs can reference CDP frames consistently across runs.

### A3. Execution Context Registry
- Implement `ExecutionContextRegistry`:
  - Attach to every CDP session once (before `Runtime.enable`).
  - On `Runtime.executionContextCreated`, if `auxData.isDefault` and `frameId`, map to `executionContextId`.
  - On `executionContextDestroyed/cleared`, drop the mapping.
- Expose APIs:
  - `getMainWorld(sessionId, frameId): number | null`.
  - `waitForMainWorld(session, frameId, timeoutMs)` that resolves once a default context exists (retrying after navigations).
- Update `FrameRecord.executionContextId` and `isolatedWorldId` whenever contexts are created (isolated worlds created via `Page.createIsolatedWorld`).
- Use this registry everywhere we evaluate scripts (DOM helpers, bounding box scripts, element resolution).

---

## 4. Workstream B — CDP Session Management

### B1. Auto-Attach & Session Cache
- Enhance the Phase 1 CDP client to:
  - Call `Target.setAutoAttach({ autoAttach: true, flatten: true, waitForDebuggerOnStart: false })`.
  - Maintain `sessionCache: Map<string /* targetId */, CDPSession>`.
  - For each attached target, send `Page.enable`, `Runtime.enable`, `DOM.enable`, `Accessibility.enable` as needed.
- Expose `getSessionForFrame(frameId)` which:
  - Checks if the frame already has `sessionId`.
  - If not, uses `Target.attachToTarget({ targetId, flatten: true })` to obtain one.
  - Stores the session ID on the `FrameRecord`.

### B2. Frame Lifecycle Events & Network Manager
- Subscribe to:
  - `Page.frameAttached` → add record, assign parent, set owner session.
  - `Page.frameDetached` → remove record + child subtrees (unless `reason === "swap"`).
  - `Page.frameNavigated` → update URL/loader info, handle root swaps.
  - `Page.frameStoppedLoading` → inform the network manager (below) for document requests.
- Mirror events for the OOPIF sessions (auto-attached targets emit their own `Page.frame*` events). Normalize them through the main CDP client so the registry sees a unified event stream.

### B3. Cross-Session Network Manager
- Implement `NetworkManager` that tracks `Network.*` events per session:
  - Maintain `sessionId:requestId` keys, track resource types, and identify document requests per frame.
  - Expose `waitForIdle({ idleTimeMs, timeoutMs, filter })` returning a handle with `promise` and `dispose`.
- Hook into `Page.frameStoppedLoading` events to treat document requests as complete when frames finish loading.
- Integrate with the session manager so every adopted session automatically registers with the network manager.

### B4. Execution Context & World Management
- For robust script injection, create or reuse isolated worlds per frame:
  - Use `Page.createIsolatedWorld({ frameId, worldName: "hyperagent" })`.
  - Save the resulting `executionContextId` in `FrameRecord.isolatedWorldId`.
  - Provide helper `getExecutionContext(frameId)` returning the best context ID (isolated world prefered).

---

## 5. Workstream C — Frame Resolution APIs

### C1. Public API Surface
- `src/cdp/frame-resolver.ts` exposes:
  ```ts
  export interface FrameResolution {
    frameId: string;
    session: CDPSession;
    executionContextId: number;
    isolatedWorldId?: number;
    backendNodeId?: number;
    iframeEncodedId?: EncodedId;
  }

  export function resolveFrame(encodedFrameIndex: number | string, graph: FrameGraph): FrameResolution;
  export function resolveFrameOwner(encodedId: EncodedId, graph: FrameGraph): FrameResolution;
  ```
- Provide helper `attachToFrame(frameId)` that ensures the session/context exist, calling `Target.attachToTarget` as needed.

### C2. DOM Utilities
- Replace XPath-based frame traversal (`resolveFrameByXPath`) with CDP calls:
  - When needing parent iframe info, call `DOM.getFrameOwner`.
  - When needing to enumerate frames, rely on `FrameGraph`.
- Provide `getFramePath(frameId)` returning breadcrumbs for debugging (list of URLs/names up to main frame).

### C3. Alignment with Encoded IDs
- Update `EncodedId` generation (Phase 2/3) so the `frameIndex` segment corresponds to a deterministic ordering derived from the `FrameGraph`.
- Keep a mapping `frameIndex → frameId` inside DOM state; this lets existing encoded IDs continue to work while internal logic uses `frameId`.

---

## 6. Workstream D — Agent & DOM Integration

### D1. DOM Extraction
- Modify `getA11yDOM` to:
  - Use the `FrameGraph` for iterating frames, rather than Playwright frame handles.
  - For each frame, pass its session/context to DOM extraction helpers.
  - Include the new metadata (`frameId`, `sessionId`, `executionContextId`, `iframeEncodedId`) in the returned `frameMap`.

### D2. Element Resolution (Phase 2 dependency)
- Update the Phase 2 `resolveElement` to:
  - Accept either `frameIndex` or direct `frameId`.
  - Fetch the correct session/context via `FrameGraph`.
  - Use `DOM.resolveNode` within that session, with no Playwright dependency.

### D3. Action Execution
- `ActElementAction` and `executeSingleAction` now call `resolveFrame` to ensure correct session/context, then pass these to the CDP interaction functions. If the `executionContextId` changes mid-action (navigation), use the registry to re-fetch.
- Frame switching (e.g., for in-frame navigation actions or DOM diffing) uses the registry to know when a frame has navigated or been replaced.

### D4. Debugging
- Extend debug artifacts to include a `frames.json` file with the full registry snapshot (frameId, URL, parent, encoded index, sessionId).
- Provide CLI helpers/log statements like `[FrameGraph] Attached frame frameId=ABC parent=DEF url=https://...`.

## 7. Workstream E — Lifecycle & Navigation Coordination

### E1. Lifecycle Watcher
- Build `LifecycleWatcher` that mirrors Playwright semantics:
  - Listens for `Page.frameNavigated`, `Page.frameDetached`, `NetworkManager` idle signals, and navigation command IDs.
  - Supports `waitUntil: "load" | "domcontentloaded" | "networkidle"`.
  - Detects superseded navigations (when a new navigation command starts or main frame detaches) and rejects with descriptive errors.

### E2. Wait Helpers
- Expose `waitForDomNetworkQuiet(page, timeoutMs)` that:
  1. Uses `LifecycleWatcher` to await `networkidle`.
  2. Optionally ensures the document request finished for the relevant frame.
- Replace legacy `waitForSettledDOM` uses with this helper during Phase 5.

### E3. Tests
- Unit tests mocking CDP events to ensure watchers resolve/reject appropriately.
- Integration tests performing navigations with redirects, aborted loads, and verifying `waitUntil` semantics.

---

## 8. Testing Strategy

### T1. Unit Tests
- `frame-graph.test.ts`: CRUD operations, parent/child relationships, path resolution.
- `frame-resolver.test.ts`: confirm `resolveFrame` finds correct session/context, throws on missing frames.

### T2. Integration / Scripts
- Extend `scripts/test-page-iframes.ts` to cover:
  - Nested same-origin iframes.
  - Cross-origin OOPIF (e.g., embed `https://example.com`).
  - Dynamic iframe insertion/removal.
- Validate event handling by listening for `frameDetached` in a test page that removes an iframe mid-task.

### T3. Stress / Diagnostics
- Add a `scripts/debug-frame-graph.ts` utility that prints the current frame graph for any page (manual debugging).
- Log warnings when CDP frame events refer to unknown frameIds (helps catch registry desyncs early).

---

## 9. Rollout & Migration
1. **Behind feature flag** `cdpFrames?: boolean`, default `false`.
2. **Shadow mode**: build the frame graph but keep using existing Playwright frame resolution until confidence grows.
3. **Cutover**: once stable, remove Playwright frame references (`resolveFrameByXPath`, `playwrightFrame` fields) and rely solely on CDP metadata.
4. **Connector-ready**: with Playwright removed from frame management, connectors can pass their own `FrameGraph` data without modification.

---

## 10. Deliverables Checklist
- [ ] `FrameGraph` data structures + helpers (`frame-graph.ts`).
- [ ] Enhanced CDP client with auto-attach + session cache + network manager integration.
- [ ] `frame-resolver.ts` APIs (resolveFrame, attachToFrame, getFramePath).
- [ ] Updated `IframeInfo`/DOM state to include CDP metadata.
- [ ] DOM extraction + element resolution using `FrameGraph`.
- [ ] Lifecycle event handling + debug artifacts.
- [ ] Execution context registry + wait helpers.
- [ ] Unit + integration tests covering nested/OOPIF frames.

With Phase 3 completed, HyperAgent no longer depends on Playwright for frame management, enabling seamless support for connectors and upcoming CDP-only features.
