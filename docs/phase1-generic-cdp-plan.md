# Phase 1 Plan: Generic CDP Abstraction & Puppeteer Provider

> **Status note:** The dedicated `CdpConnection` transport described below was removed once we standardized on Playwright's private CDP session IDs. The rest of the plan (adapters, frame metadata, etc.) remains relevant historical context.

## 1. Objectives
- **Unify CDP access** so DOM capture, screenshots, and interaction code stop reaching directly into Playwright sessions.
- **Prepare for multiple browser drivers** by defining driver-agnostic interfaces plus concrete adapters for Playwright and (later) Puppeteer.
- **Lay groundwork for Phase 2–6** (CDP selectors/interactions, frame management) without rewriting everything at once.

Scope covers Detailed Plan sections 1.1–1.2 from the integration roadmap; no behavioral changes should leak past the new abstraction until it is wired behind feature flags/tests.

---

## 2. Current Pain Points
| Area | Problem Today | Impact |
| --- | --- | --- |
| CDP usage | Every caller (`getA11yDOM`, `waitForSettledDOM`, screenshot helpers, extract action) calls `page.context().newCDPSession(...)` directly. | Hard to patch in Puppeteer (different call sites), no shared logging/error handling, no way to pool sessions. |
| Browser providers | `BrowserProviders` type is `"Local" | "Hyperbrowser"` only; both assume Playwright. | Cannot add Puppeteer without duplicating large pieces of HyperAgent. |
| Frame metadata | `IframeInfo` stores `playwrightFrame` handles only. | Anything CDP-only needs session IDs/execution contexts per frame. |

---

## 3. Workstream A — CDP Core (Plan item 1.1)

### A1. Directory & Type Skeleton
1. Create `src/cdp/` with:
   - `types.ts`:  
     ```ts
     export interface CDPSession {
       send<T = unknown, P = Record<string, unknown>>(method: string, params?: P): Promise<T>;
       on(event: string, handler: (payload: unknown) => void): void;
       off?(event: string, handler: (payload: unknown) => void): void;
       detach(): Promise<void>;
       raw?: unknown;
     }
     export interface CDPClient {
       rootSession: CDPSession;
       createSession(target: CDPTargetDescriptor): Promise<CDPSession>;
       dispose(): Promise<void>;
     }
     export interface CDPFrameHandle {
       frameId: string;
       sessionId?: string;
       executionContextId?: number;
       isolatedWorldId?: number;
       backendNodeId?: number;
       driverFrame?: unknown;
     }
     ```
   - `targets.ts` / `frames.ts` helpers for shared metadata transforms (mirrors future Phase‑3 needs).
   - `errors.ts` for consistent wrapping (attach method name/params when CDP commands fail).

2. Add `src/cdp/playwright-adapter.ts` implementing the interfaces:
   - Accepts a Playwright `Page`.
   - Lazily creates one root `CDPSession`.
   - Implements `createSession(target)` by calling `context().newCDPSession(target.handle ?? target.frame)`; caches/dereferences sessions.
   - Normalizes event API (`session.on`, `session.off`).

3. Write `src/cdp/index.ts` exporting factories:
   ```ts
   export const createCDPClient = (page: BrowserPageAdapter): Promise<CDPClient>;
   ```
   `BrowserPageAdapter` initially just wraps Playwright’s `Page`, but keeps the public shape we’ll flesh out in Phase 4.

### A2. Plumbing Into Existing Callers (no behavior change)
Goal: Introduce the abstraction without moving logic yet.

1. **Injection Strategy**
   - Extend `HyperAgent` (and `AgentCtx`) with an optional `cdp` cache keyed by `Page` instances.
   - Provide `getCDPClient(page)` helper that returns the cached `CDPClient` (creating it via Playwright adapter).
2. **Call Site Updates (thin wrappers)**
   - `getA11yDOM`: replace `page.context().newCDPSession(page)` with `const client = await getCDPSession(page);` that returns `CDPSession`.
   - `waitForSettledDOM`, `compositeScreenshot`, `extract` action, debugging utilities: same change.
   - Keep the rest of the logic untouched; only the session creation layer shifts.
3. **Lifecycle Management**
   - When `HyperAgent.closeAgent()` runs, dispose cached CDP clients (detach sessions).
   - Add defensive cleanup if a page closes (listen to `page.on("close")` inside adapter).
4. **Telemetry / Debug Hooks**
   - Add `debug` logs for session creation/detach to trace CDP churn while dogfooding.

### A3. Frame Metadata Prep
1. Update `IframeInfo` (in `src/context-providers/a11y-dom/types.ts`) to include optional CDP identifiers:
   ```ts
   interface IframeInfo {
     cdpSessionId?: string;
     cdpExecutionContextId?: number;
     cdpIsolatedWorldId?: number;
     frameDOMNodeId?: number;
   }
   ```
2. Extend `buildBackendIdMaps` / AX-tree fetchers to populate new fields **if** the data is available from the generic CDP client. For Phase 1 we can stub `cdpSessionId` with the session used for an OOPIF (Playwright adapter knows the `CDPSession.id`), leaving the rest `undefined`.
3. Document how later phases will rely on these properties (direct selectors, runtime evaluation).

### A4. Testing & Validation
1. Unit-level: add lightweight tests for the Playwright adapter (mock `Page.context().newCDPSession`) to confirm `send`, `detach`, caching, and error wrapping.
2. Smoke: run `scripts/test-page-ai.ts` and `scripts/test-page-iframes.ts` to verify no regressions in DOM capture or aiAction.
3. Debug verification: enable `debug:true`, confirm new logs show shared sessions instead of per-call creation.

---
## 4. Workstream B — CDP Transport & Session Multiplexer

To support connector mode and advanced frame/session management (Phases 3–6), we need first-class ownership of the CDP WebSocket transport. Playwright’s `newCDPSession` isn’t sufficient when running outside Playwright.

### B1. Transport Layer (`src/cdp/connection.ts`)
1. Implement `CdpConnection` that:
   - Manages the raw WebSocket (`connect`, `close`, `onTransportClosed`).
   - Tracks inflight commands with IDs, resolves/rejects responses, and records stack traces for debugging.
   - Emits CDP events to registered handlers (`on/off(method, handler)`).
   - Keeps a map of `sessionId → CDPSession`.
2. Implement `CDPSession` objects with the same `send/on/off/close` interface; they delegate to the parent connection but stamp the `sessionId`.
3. Support `Target.attachToTarget`, `Target.detachFromTarget`, and `Target.getTargets`.
4. Call `Target.setAutoAttach({ autoAttach: true, flatten: true, waitForDebuggerOnStart: true, filter: [...] })` plus `Target.setDiscoverTargets({ discover: true })` during bootstrap so OOPIFs and popups automatically yield sessions.
5. Provide `onTransportClosed` hooks so higher layers can shut down cleanly when the socket dies.

### B2. Integration & Testing
- Managed mode (Playwright) can optionally inject its existing session via the adapter, but connectors will rely directly on `CdpConnection`.
- Unit tests should mock the WebSocket to ensure messages route correctly, inflight entries resolve, and session attach/detach is handled.
- Integration smoke: connect to a local Chrome instance, verify new targets produce sessions and auto-attach events fire.

## 5. Workstream C — Script Injection Manager

CDP-only flows need consistent DOM helpers (bounding boxes, cursor overlay, instrumentation) injected into every session/root document.

### C1. Manager (`src/cdp/script-injector.ts`)
1. Expose `ensureScript(session, key, source)` which:
   - Injects `source` via `Page.addScriptToEvaluateOnNewDocument`.
   - Immediately evaluates it in the current document via `Runtime.evaluate`.
   - Caches per `session.id + key` to avoid duplicate injections.
2. Listen for new CDP sessions (from Workstream B) and automatically call `ensureScript` for required scripts (bounding box collector, piercer, cursor, etc.).

### C2. Bounding Box Script Requirements
- Bounding boxes are now required whenever `cdpActions` is enabled (Phase 2). Ensure `getA11yDOM` requests bounding boxes without drawing overlays by reusing this manager.
- Provide a helper `installBoundingBoxCollector(session)` that records element rects keyed by encodedId into a shared map accessible via `Runtime.evaluate`.

### C3. Testing
- Unit tests verifying scripts inject once per session and reinject after session recreation.
- Integration: enable `cdpActions`, capture DOM state, and confirm bounding boxes exist without extra CDP round-trips.

## 6. Workstream D — Connector Prep (Plan item 1.2, no new provider yet)

We are deferring any Puppeteer-specific provider until the connector-based workflow (Phase 4) is ready. Instead, Phase 1 only needs enough scaffolding so the upcoming connector can reuse the CDP abstractions without another refactor.

### D1. API & Config Guardrails
1. Keep `BrowserProviders` union and config types unchanged for now—Playwright-backed `"Local"` / `"Hyperbrowser"` remain the only supported options.
2. Document in code/comments that the provider layer is legacy and will be replaced by connector helpers; avoid adding new knobs so removal is easy later.
3. Introduce lightweight `ConnectorConfig` types (e.g., `PlaywrightConnectorOptions`, `PuppeteerConnectorOptions`) **without** wiring them into `HyperAgent` yet. They live alongside the CDP module and describe the future `connectPlaywrightSession` / `connectPuppeteerSession` signatures.

### D2. CDP Context Sync Helper
Hyperbrowser already embodies the pattern of “create a remote browser session, then connect via CDP” (see snippet below). Rather than hard-coding Playwright-specific logic inside providers, Phase 1 introduces a helper that:

1. Accepts a “browser session descriptor” with at least a `wsEndpoint` (from Hyperbrowser or local launch), optional cookies/metadata, and a `connect` implementation.
2. Connects the driver to that endpoint (`chromium.connectOverCDP`, `puppeteer.connect`, etc.).
3. Hands both the driver page/context and the `CDPClient` back to HyperAgent so they stay in sync.

```ts
const session = await client.sessions.create({ acceptCookies: true });
const browser = await chromium.connectOverCDP(session.wsEndpoint);
const page = browser.contexts()[0].pages()[0];
await page.goto("https://example.com");
```

The helper generalizes this flow:
- `attachDriverToCDP({ wsEndpoint, connectWith })` → `{ driverBrowser, defaultContext, cdpClient }`.
- Works for local Chromium (where `connectWith` performs `chromium.launch` + `browser.newBrowserCDPSession`) and Hyperbrowser (where it simply consumes the remote endpoint).
- Makes the Hyperbrowser provider a thin shim that only manages session lifecycle (create/stop) while the helper deals with syncing CDP + driver state.

### D3. Dependency & Surface Discipline
1. **Do not add** `puppeteer` or `puppeteer-core` to `package.json` yet; the connector work will determine the final dependency strategy.
2. Split provider responsibilities conceptually (session lifecycle vs driver attachment) but keep the actual code untouched to avoid churn before the connector lands.
3. Update docs/inline comments to point users toward the upcoming connector flow so they can prepare to manage their own sessions.

---

## 5. Phase 4 Preview — Connector-Only Browser Setup

Although Phase 1 still works within the existing provider abstraction, the long-term plan (Phase 4 of the integration roadmap) is to eliminate `browserProvider` entirely and let users bring their own browser sessions. The flow will look like:

1. **User-managed sessions**
   - Start a Hyperbrowser session via the public Sessions API (cloud) *or*
   - Launch/attach to a local Chromium instance however they like (Playwright `chromium.launch`, Puppeteer `launch/connect`, Selenium CDP, etc.).
2. **HyperAgent connector helper**
   - HyperAgent exports `connectPlaywrightSession({ context, cdp })` and `connectPuppeteerSession({ browser, cdp })`.
   - These helpers accept the already-initialized driver objects and reuse the shared CDP context helper to sync pages/frames and expose the `CDPClient`.
3. **Internals stay CDP-first**
   - The CDP helper tracks sessions per page/frame.
   - Driver-specific glue (Playwright/Puppeteer) resides only inside the connector, so the agent core never talks to Playwright APIs directly.

Implications for current work:
- The new CDP module and frame metadata fields we add in Phase 1 become the backbone of the connector.
- While we keep `browserProvider` around for backward compatibility in Phases 1–3, we should keep its surface area minimal so it can be retired cleanly when connectors ship.

This preview doesn’t add new requirements to Phase 1, but it informs naming/architecture choices (e.g., favor `BrowserPageAdapter` terminology, keep CDP helper stateless) so we can pivot smoothly when we drop the provider layer.

---

## 6. Execution Order & Milestones
1. **Milestone A (Adapters ready)** — `src/cdp/types.ts`, Playwright adapter, and legacy CDP call sites routed through the helper.
2. **Milestone B (Transport & scripts)** — `CdpConnection`, auto-attach, script injector implemented and covered by tests.
3. **Milestone C (Connector prep)** — CDP context helper outlined, connector option types stubbed, legacy provider surface documented as transitional.
4. **Milestone D (Validation + Docs)** — Smoke tests recorded, README/docs mention new architecture, open TODOs logged for later phases (selectors, interactions, frames).

---

## 6. Risks & Mitigations
| Risk | Mitigation |
| --- | --- |
| CDP session leaks (multiple callers sharing one adapter) | Central cache + `page.on("close")` cleanup, `dispose()` called from `closeAgent`. |
| Puppeteer dependency bloat | Mark as optional, lazy-import, guard provider initialization with friendly error messages. |
| Divergent CDP semantics (Playwright vs Puppeteer) | Keep `CDPClient` surface minimal (only `send/createSession/detach`) so driver-specific quirks stay inside adapters. |
| Timeline creep before later phases | Document TODOs (e.g., hooking `IframeInfo.cdpSessionId`) but avoid using them until Phase 2+, ensuring Phase 1 lands quickly. |

---

## 7. Deliverables Checklist
- [ ] `src/cdp/types.ts`, `playwright-adapter.ts`, and index exports.
- [ ] `CdpConnection` transport + session auto-attach + tests.
- [ ] Script injection manager ensuring bounding box/DOM helpers exist in every session.
- [ ] HyperAgent CDP cache + refactored CDP callers (`getA11yDOM`, `waitForSettledDOM`, `compositeScreenshot`, extract action, etc.).
- [ ] Extended `IframeInfo` and associated map builders capturing CDP metadata (placeholder values allowed).
- [ ] Connector option types + CDP context helper notes (no new provider yet).
- [ ] Optional dependency + docs/test notes.
- [ ] Smoke test commands recorded in PR template.

Completing the above provides a stable foundation for Phase 2’s CDP selectors and Phase 3’s frame management while keeping the public API unchanged. ***
