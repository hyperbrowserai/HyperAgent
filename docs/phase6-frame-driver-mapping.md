# Phase 6 Plan: Frame-to-Driver Mapping System

Objective: build a bidirectional mapping between CDP frame identifiers and browser-driver-specific frame handles (Playwright/Puppeteer), enabling better debugging, diagnostics, and optional driver-specific fallbacks without compromising the CDP-first architecture.

Scope corresponds to integration roadmap Phase 6 (items 6.1–6.2).

---

## 1. Motivation
- Even though actions will be CDP-driven, developers still rely on Playwright/Puppeteer frame references for debugging and optional workflows (e.g., taking driver-level screenshots, leveraging driver-specific APIs).
- For connectors, we need a consistent way to associate driver frames with CDP `frameId`s (and vice versa) so tools like visual debuggers can show “frame 3 = `https://example.com` (CDP frameId AAA) = Playwright frame handle XYZ”.
- Frame lifecycle events should update both sides of the mapping, ensuring driver handles stay in sync with CDP frame graph.

---

## 2. Desired Capabilities
1. **Mapping data structure**:
   - `FrameMapping` objects capturing `cdpFrameId`, `cdpSessionId`, `driverFrameHandle`, parent/child relationships, encoded ID, etc.
   - Separate stores for Playwright vs Puppeteer (since handles differ), but a common interface to look up by frameId or handle.
2. **Bidirectional lookups**:
   - `getDriverFrame(handleType, cdpFrameId)` → driver-specific frame reference (if available).
   - `getCDPFrameId(handleType, driverFrame)` → frameId for logging/backtracking.
3. **Lifecycle sync**:
   - Consume CDP frame events (`frameAttached`, `frameDetached`, etc.) and driver frame events (if exposed) to keep mappings fresh.
4. **Optional usage**:
   - Agent core continues using CDP-only data; driver mappings are used for diagnostics, optional scripts, and user-defined hooks.

---

## 3. Workstream A — Mapping Model

### A1. FrameMapping Type
Create `src/frames/mapping.ts`:
```ts
export interface FrameMapping {
  cdpFrameId: string;
  cdpSessionId?: string;
  parentFrameId?: string | null;
  childFrameIds: Set<string>;
  driverType: "playwright" | "puppeteer";
  driverContext?: unknown;
  driverFrame?: unknown;
  connectorId?: string; // identifier for connector instance
  lastUpdated: number;
}

export interface FrameMappingStore {
  add(mapping: FrameMapping): void;
  update(frameId: string, patch: Partial<FrameMapping>): void;
  remove(frameId: string): void;
  get(frameId: string): FrameMapping | undefined;
  findByDriverFrame(driverType: string, driverFrame: unknown): FrameMapping | undefined;
}
```
- Provide an in-memory implementation backed by `Map<string, FrameMapping>`, with helper indexes (`WeakMap` for driver frame handles).
- Track `connectorId` to support multiple browser contexts simultaneously.

### A2. Encoded IDs
- Maintain `encodedFrameIndex ↔ frameId` mapping derived from the Phase 3 `FrameGraph` so debugging artifacts can reference both forms.

---

## 4. Workstream B — Playwright Mapping Adapter

### B1. Capture Frames on Startup
- When wrapping Playwright contexts (Phase 4 adapter), iterate over `context.pages().flatMap(p => p.frames())` and register each frame:
  - Retrieve `frame._id` (Playwright internal) or use heuristics to identify the corresponding CDP `frameId` via `frame._context._impl._frameId`.
  - Add entries into the mapping store with `driverType: "playwright"`.

### B2. Event Hooks
- Subscribe to Playwright’s frame events (`frameattached`, `framedetached`, `framenavigated`) and update the mapping store.
- When frames detach, remove entries and mark child entries accordingly.

### B3. CDP Cross-Linking
- Use the Phase 3 `FrameGraph` to match Playwright frame data (URL, parent) with CDP `frameId`. Where multiple candidates exist, prioritize matching by frame hierarchy path (e.g., root→child sequence).
- Once matched, persist the association so future lookups are O(1).

---

## 5. Workstream C — Puppeteer Mapping Adapter

### C1. Initial Mapping
- On connector initialization, iterate over `browser.pages()` and their frames.
- Use Puppeteer’s `frame._id` or `frame._name` plus `frame._client._targetId` to derive the CDP `frameId`.
- Register each mapping with `driverType: "puppeteer"`.

### C2. Event Hooks
- Puppeteer exposes `page.on("frameattached")`, `page.on("framedetached")`, etc. Hook into these to maintain the store.

### C3. Sessions
- Puppeteer’s CDP sessions may differ from the main connection; ensure the mapping store records the correct `cdpSessionId` for each frame (leveraging Phase 3 session manager).

---

## 6. Workstream D — Registry API & Diagnostics

### D1. Public API
- Expose utilities like:
  ```ts
  export function getDriverFrameById(frameId: string, driverType: "playwright" | "puppeteer"): unknown | undefined;
  export function getCDPFrameIdFromDriver(driverType: string, driverFrame: unknown): string | undefined;
  export function listFramesByDriver(driverType: string): FrameMapping[];
  ```
- Provide TypeScript generics so adapters can return strongly typed frames (e.g., `Frame<"playwright">`).

### D2. Debug Info
- Expand debug artifacts to include `frame-driver-map.json` showing CDP IDs, driver handles (redacted), URLs, parent-child relationships.
- Add CLI command (optional) `yarn debug:frames` that prints the mapping for the current session.

### D3. Connector Hooks
- Allow connectors to register custom callbacks when frames attach/detach, leveraging the shared mapping store (useful for advanced users).

---

## 7. Workstream E — Agent/Action Integration

### E1. Optional Driver Fallbacks
- While CDP remains the primary execution path, provide optional hooks:
  - `ActionContext.getDriverFrame(encodedId)` returns the driver-specific frame (if available) for debugging or scripts.
  - Keep these APIs “best effort”—they may return undefined if the driver doesn’t expose frames (e.g., headless connectors).

### E2. Visual Debugging
- Future visual overlay tooling can use the mapping to fetch driver-level screenshots or DOM snapshots per frame, if needed.

### E3. Frame Lifecycle
- Align `frameMap` updates from Phase 3 with the mapping store so both CDP and driver views remain in sync.

---

## 8. Testing Strategy

### T1. Unit Tests
- Validate `FrameMappingStore` CRUD operations, lookup by driver frame, stale entry cleanup.

### T2. Integration Tests
- Extend `scripts/test-page-iframes.ts` to:
  - Assert `getDriverFrameById` returns a Playwright frame for main + nested iframes.
  - Detach an iframe and ensure mapping removes it.
- Add Puppeteer connector test (if optional dependency installed) verifying the mapping works end-to-end.

### T3. Stress Tests
- Use a test page that dynamically creates/destroys many iframes to ensure the mapping store keeps up without memory leaks.

---

## 9. Rollout
1. Introduce the mapping store behind a feature flag (`frameDriverMap?: boolean`) defaulting to `false`.
2. Enable internally to validate behavior with complex iframe pages.
3. Once stable, expose public helper APIs and document them.
4. Coordinate with connector documentation to highlight how users can leverage driver handles for debugging.

---

## 10. Deliverables Checklist
- [ ] `FrameMapping` types + store implementation.
- [ ] Playwright adapter integration (initial sync + event hooks).
- [ ] Puppeteer adapter integration.
- [ ] Registry API + debug artifacts.
- [ ] Optional ActionContext helper + documentation.
- [ ] Unit/integration tests.

Completing Phase 6 ensures HyperAgent maintains a clear bridge between CDP state and driver-specific contexts, making debugging easier and future driver integrations safer without compromising the CDP-first execution path.
