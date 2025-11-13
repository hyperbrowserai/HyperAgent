# Phase 3 — Dedicated CDP Connection Plan

Objective: Run Playwright and a first-class CDP client side-by-side so we can manage frames, sessions, and execution contexts directly (no Playwright frame handles, no XPath traversal). This mirrors Stagehand v3’s architecture and unlocks true frame-first resolution.

---

## 1. Assumptions & How We Validate Them

| Assumption | Validation Strategy |
|------------|---------------------|
| **A1. Playwright-launched Chromium accepts a debugging port we can reuse.** | Chromium already accepts `--remote-debugging-port`. We’ll inject `--remote-debugging-port=0` (if not provided) when launching the browser. After launch, Playwright exposes the websocket via `browser._connection.url()` or `browser.newBrowserCDPSession()._connection.url()`. Stagehand and Puppeteer rely on the same CDP endpoint, so sharing it is supported. |
| **A2. Hyperbrowser exposes a CDP websocket.** | Hyperbrowser’s API already returns `wsEndpoint`. We simply connect both Playwright (`chromium.connectOverCDP(ws)`) and our client to that URL. No extra flags needed. |
| **A3. Chrome supports multiple CDP clients simultaneously.** | Chrome routes protocol messages by `sessionId`. As long as each client tracks its own session IDs, commands/events stay isolated. Stagehand connects two clients at once (driver + understudy) without conflict. |
| **A4. We can adopt target sessions on demand.** | Once we control the socket we can call `Target.attachToTarget`/`Target.setAutoAttach`. Chrome returns `sessionId`; we store it and send commands through that session. This is the standard CDP flow (used by Puppeteer when flattening). |
| **A5. We can keep both connections in sync.** | We listen for `Browser.disconnect`/Playwright `browserContext.close()` and close our CDP connection at the same time. CDP emits `Target.detachedFromTarget` events we can mirror into the manager, so frame teardown stays consistent. |

If any assumption fails (e.g., Playwright changes its private `_connection` API), we document the fallback (launching Chromium ourselves or upgrading Playwright). For now the APIs exist in all current versions.

---

## 2. Architecture Overview

1. **Launch** (local provider): add `--remote-debugging-port=0` to Chromium args. Let Chrome pick the port and read the websocket URL from Playwright’s connection.
2. **Hyperbrowser**: reuse the `wsEndpoint` they provide (no launch changes).
3. **CDP Connection (`CdpConnection`)**: open a websocket to the endpoint, maintain inflight command map, session registry, and emit events.
4. **Auto-attach / target management**: after connecting, call `Target.setAutoAttach({ autoAttach: true, flatten: true })`. Every time Chrome attaches to a target (iframe/OOPIF) we create a `CdpSession` and register it with `FrameContextManager`.
5. **FrameContextManager**: stores FrameRecords (frameId, parent, sessionId, executionContextId, backend node). Provides APIs to resolve frames by encoded index or frameId.
6. **Resolvers / DOM extraction**: get `{ session, executionContextId }` from the manager and send all CDP commands directly—no Playwright `Frame` handles, no XPath traversal across frames.

Playwright still controls navigation/input; our CDP client handles frame/session plumbing.

---

## 3. Implementation Plan (Detailed)

### Step 1: Launch Integration
- Update `LocalBrowserProvider` (and Hyperbrowser equivalent) to:
  - Append `--remote-debugging-port=0` if not supplied.
  - After launch, read `browser._connection.url()` (private API) or call `browser.newBrowserCDPSession()._connection.url()` to obtain the websocket URL.
  - Store `{ browser, wsEndpoint }` on the provider so the CDP layer can access it.
- For Hyperbrowser, the wsEndpoint already exists; we simply pass it through to both Playwright and our CDP client.

### Step 2: Build `CdpConnection`
- New module `src/cdp/cdp-connection.ts`:
  - Opens the websocket and handles JSON messages (similar to Stagehand’s `CdpConnection`).
  - Tracks inflight requests (`id → { resolve, reject }`).
  - Maintains `Map<sessionId, CdpSession>` where each session has `send`, `on`, `off` methods.
  - Emits events for `Target.attachedToTarget`, `Target.detachedFromTarget`, `Runtime.executionContextCreated`, etc.
  - Exposes helpers:
    ```ts
    send(method, params)
    attachToTarget(targetId): Promise<CdpSession>
    setAutoAttach(flatten: true)
    on(method, handler)
    ```

### Step 3: Hook into Playwright lifecycle
- When a Playwright `Page` is created, locate its corresponding CDP target (via `Page.targetId` or `browserContext._connection.rootSessionId`). Use our CDP client to:
  - Call `Target.setAutoAttach({ autoAttach: true, flatten: true, waitForDebuggerOnStart: false })`.
  - Optionally call `Target.setDiscoverTargets({ discover: true })` so we see OOPIF target IDs before they attach.
- Listen for `Page.close()`/`browserContext.close()` and call `cdpConnection.close()` to avoid leaking sockets.

### Step 4: FrameContextManager updates
- ✅ Manager already owns the FrameGraph + execution-context registry.
- ✅ On `ensureInitialized` we auto-attach, call `Page.getFrameTree`, and seed FrameRecords.
- ✅ `Target.attachedToTarget` + `Page.frameAttached/Detached/Navigated` keep frame → session mappings up to date.
- ✅ Resolver APIs (`getFrameSession`, `waitForExecutionContext`, `frameGraphSnapshot`) now back all CDP interactions.

### Step 5: Refactor resolvers & DOM extraction
- Update `resolveElement` to use the manager (`resolveFrameIndex`) rather than `frameInfo.playwrightFrame`. If the manager cannot resolve a frame (e.g., before initialization), fall back to the current behavior temporarily, but log a warning.
- Update `getA11yDOM` to iterate the FrameGraph. For each frame:
  - Acquire its session from the manager.
  - Enable `Accessibility`, `DOM`, etc. on that session (once per session via lazy guards).
  - Fetch AX trees/bounding boxes from that session.
- Remove `resolveFrameByXPath` and other Playwright-specific frame helpers once this path is stable.

### Step 6: Lifecycle watcher & tests
- ✅ Lifecycle events wired into FrameContextManager; `waitForSettledDOM` delegates to the new `waitForLifecycle` + network-idle helper.
- ⏳ Tests still pending (see Phase 5 plan) once the architecture stabilizes.

---

## 4. Risk Mitigation
- **Playwright private API access:** reading `_connection.url()` is not public. If Playwright changes it, we can fall back to launching Chromium ourselves (using the same arguments) and connecting via Puppeteer-style `connect()` while Playwright attaches with `connectOverCDP`.
- **Multiple CDP clients interfering:** we must ensure we don’t enable a domain twice in conflicting ways. We’ll centralize domain enabling inside the manager (e.g., track `DOM.enable` per session) to avoid redundant calls.
- **Cleanup:** tie the CDP connection lifetime to Playwright’s context. When `browserContext.close()` fires, we dispose our connection; when the CDP connection closes unexpectedly, notify Playwright (or just log) since Chrome will also drop Playwright’s connection.

---

## 5. Deliverables
1. `CdpConnection` + glue code to reuse the Chromium debugging endpoint.
2. ✅ FrameContextManager powered by raw CDP sessions (frameId → sessionId) with auto-attach + lifecycle events.
3. ✅ Resolver / DOM extraction refactored to use the manager instead of Playwright frames.
4. ✅ Lifecycle watcher + execution context registry.
5. ⏳ Tests/documentation updates (ongoing).

Once these land, Phase 3’s promise—frame-first, CDP-only element resolution—is fulfilled. All nested frames (same-origin or OOPIF) will be handled through CDP sessions with no XPath traversal, giving us the speed boost we set out to achieve.
