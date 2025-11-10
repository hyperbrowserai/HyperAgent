# Phase 4 Plan: Browser Driver Abstraction Layer

Objective: decouple HyperAgent from Playwright-specific APIs by introducing a thin abstraction that supports both Playwright and Puppeteer (and future drivers) via shared CDP plumbing. This phase also lays the groundwork for the connector-only workflow, where users bring their own sessions.

Scope corresponds to integration roadmap Phase 4 (items 4.1–4.2 & future connector preview).

---

## 1. Goals & Constraints
- Provide a `GenericPage`/`GenericBrowserContext` interface that exposes the minimal set of methods HyperAgent needs (`goto`, `screenshot`, `close`, etc.).
- Keep the majority of operations CDP-driven (DOM capture, interactions, frame management) so the driver abstraction only covers lifecycle and convenience utilities.
- Support two usage modes:
  1. **Managed Mode**: HyperAgent still instantiates Playwright (or Hyperbrowser) under the hood via a legacy provider (back-compat).
  2. **Connector Mode**: User supplies an existing Playwright or Puppeteer page/context that HyperAgent wraps via connector helpers.
- Maintain backward compatibility for current `HyperPage` users until we fully transition to connectors.

---

## 2. Current Pain Points
- `HyperAgent` assumes Playwright `Page` everywhere (`page.locator`, `page.context()`, etc.).
- `browserProvider` is tightly coupled to Playwright-based session creation.
- There is no structured way to attach an external browser (e.g., user-provided Puppeteer context).
- Puppeteer support would currently require rewriting large parts of the agent.

---

## 3. Architecture Overview
1. **Generic interfaces** describing the subset of browser/page functionality used by HyperAgent.
2. **Driver adapters** (PlaywrightAdapter, PuppeteerAdapter) that implement those interfaces.
3. **Connector helpers** allowing users to wrap an existing Playwright/Puppeteer context and plug it into HyperAgent.
4. **Legacy provider bridge** (Phase 1/2 codepath) that still creates Playwright sessions internally but immediately wraps them in the adapter.
5. **CDP integration**: the generic page must expose `getCDPClient()` which returns the Phase 1 CDP client/cache, ensuring common CDP entry points.
6. **Context orchestration**: a `GenericContext` (akin to Stagehand’s `V3Context`) that owns the transport, Target auto-attach wiring, and `GenericPage` lifecycle so connectors can manage multiple tabs and OOPIFs.

---

## 4. Workstream A — Generic Interfaces

### A1. Define Shared Types
Create `src/browser/generic-types.ts`:
```ts
export interface GenericBrowser {
  newPage(): Promise<GenericPage>;
  pages(): Promise<GenericPage[]>;
  close(): Promise<void>;
}

export interface GenericPage {
  goto(url: string, options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle"; timeoutMs?: number }): Promise<void>;
  url(): Promise<string>;
  screenshot(options?: { type?: "png" | "jpeg"; fullPage?: boolean }): Promise<Buffer>;
  bringToFront?(): Promise<void>;
  close(): Promise<void>;
  getCDPClient(): Promise<CDPClient>;
  rawPage: unknown; // driver-specific page for escape hatches
}

export interface GenericBrowserContext {
  newPage(): Promise<GenericPage>;
  pages(): Promise<GenericPage[]>;
  close(): Promise<void>;
  rawContext: unknown;
}
```
- Keep the surface area minimal—no Playwright-only constructs (locator, expect, etc.).
- Add `GenericBrowserProvider` interface describing start/stop semantics for managed mode.

### A2. Capability Flags
- Define optional flags (e.g., `supportsVideo`, `supportsTracing`) for future features but default to `false`.

---

## 5. Workstream B — Driver Adapters

### B1. Playwright Adapter
- File: `src/browser/adapters/playwright-adapter.ts`
- Responsibilities:
  - Accept a Playwright `Page`/`BrowserContext`.
  - Implement `GenericPage` by delegating to Playwright methods.
  - Lazily create/use the Phase 1 CDP client (`createCDPClient(page)`).
  - Provide helper `fromPlaywright(page: Page): GenericPage`.
  - Provide `wrapContext(context: BrowserContext): GenericBrowserContext`.
- Ensure adapter methods hide Playwright-specific options (e.g., map `waitUntil` values to Playwright’s equivalents).

### B2. Puppeteer Adapter
- File: `src/browser/adapters/puppeteer-adapter.ts`
- Responsibilities mirror the Playwright adapter:
  - Accept Puppeteer `Page`/`BrowserContext`.
  - Implement `GenericPage` by delegating to Puppeteer methods.
  - Use `target.createCDPSession()` to feed the shared CDP client (or connect via `page.target().createCDPSession()`).
- Note: we can import Puppeteer lazily (only in connector paths).

### B3. Adapter Registry
- Add `src/browser/adapters/index.ts` exposing `createGenericPage(driverType, rawPage)`.
- Define `DriverType = "playwright" | "puppeteer"` initially (extensible).

---

## 6. Workstream C — Connector Helpers

### C1. Playwright Connector
- Exported from `src/connectors/playwright.ts`:
  ```ts
  export interface PlaywrightConnectorOptions {
    page: Page;
    context?: BrowserContext;
  }

  export function connectPlaywrightSession(options: PlaywrightConnectorOptions): HyperPage;
  ```
- Internally:
  - Wrap the Playwright page in `GenericPage`.
  - Attach the CDP client.
  - Initialize `HyperAgent` with this generic page (bypassing provider start).

### C2. Puppeteer Connector
- Similar helper accepting `puppeteer.Page` (or `Browser`) and returning a `HyperPage`.
- Notes:
  - If only a browser is provided, the helper can create a new page behind the scenes.
  - Ensure CDP client creation works for Puppeteer’s `target`.

### C3. Connector Flow
- Document the flow:
  1. User starts a session (Hyperbrowser API, local launch, remote).
  2. User obtains Playwright or Puppeteer page/context.
  3. User calls `connect{Driver}Session` to get a `HyperPage`.
  4. User calls `page.ai()` / `page.aiAction()` as before.
- Provide TypeScript examples in docs.

---

## 7. Workstream D — Managed Mode Bridge

### D1. Provider Refactor
- Update `browserProvider` implementations (Local, Hyperbrowser) to:
  - Continue launching Playwright browsers.
  - Immediately wrap the resulting context/page with the adapter.
  - Expose both the raw Playwright objects and the generic wrappers.
- This allows `HyperAgent` to operate purely on `GenericPage` even in managed mode.

### D2. HyperAgent Changes
- `HyperAgent.currentPage` becomes `GenericPage`.
- `HyperAgent.newPage()` returns a `GenericPage` (wrapped Playwright in managed mode).
- All internal references to Playwright types are removed/replaced with generic interfaces.
- Where direct Playwright APIs are still needed (e.g., temporary fallback code), consolidate them under an adapter-specific `rawPage` access with guard rails.

### D3. HyperPage Interface
- Update `HyperPage` typedef to extend `GenericPage` (plus AI methods).
- Example:
  ```ts
  export interface HyperPage extends GenericPage {
    ai(...): Promise<TaskOutput>;
    aiAction(...): Promise<TaskOutput>;
    extract(...): Promise<unknown>;
  }
  ```

---

## 8. Workstream E — CDP Client Integration

### E1. Shared CDP Cache
- Ensure both adapters call a unified `getOrCreateCDPClient(rawPage)` helper so CDP sessions are reused regardless of driver.
- For Puppeteer, this may involve `page.target().createCDPSession()`; wrap that inside the helper.

### E2. Driver-Agnostic Hooks
- Move any Playwright-specific script injections (e.g., bounding box script) into CDP calls so connectors behave the same regardless of driver.

---

## 9. Workstream F — Generic Context Manager

### F1. Responsibilities
- `GenericContext` owns the `CdpConnection` and:
  - Listens for `Target.*` events, auto-creating/destroying `GenericPage` instances.
  - Adopts OOPIF child sessions, wiring them into the Phase 3 frame graph, execution context registry, and network manager.
  - Tracks active pages/popups (`activePage()`, `setActivePage`) and exposes `pages()` in creation order.
  - Ensures required scripts (bounding boxes, piercer) are installed via the Phase 1 script injector on every new session.
  - Provides lookup helpers (`resolvePageByFrameId`, `getFullFrameTree(mainFrameId)`).

### F2. Connector Hooks
- `connectPlaywrightSession` / `connectPuppeteerSession` instantiate `GenericContext` by:
  - Passing a raw `CdpConnection` (when connecting to a ws endpoint directly), or
  - Providing driver objects so the adapter can extract the underlying CDP endpoint and seed the context.
- Emit events/callbacks (page created, page closed, popup opened) for advanced users to hook into.

### F3. Diagnostics
- Maintain metadata (`createdAt`, target type, last active time) per page for debugging.
- Provide CLI tooling (`yarn debug:frames`) to dump frame graphs and active pages.

### F4. Tests
- Integration: connect to a local Chrome instance, open multiple tabs/popups, verify the context tracks them and adopts OOPIF frames.
- Ensure connectors (Playwright/Puppeteer) can hand off their pages/contexts and still benefit from auto-attach + script injection.

## 10. Testing Strategy

### T1. Unit Tests
- Adapter tests mocking Playwright/Puppeteer pages to ensure methods delegate correctly and `getCDPClient` is called once.
- Connector tests verifying `connectPlaywrightSession` returns a working `HyperPage`.

### T2. Integration Tests
- Existing `scripts/test-page-ai.ts` runs with the legacy provider (Playwright).
- Add an opt-in script `scripts/test-connector-playwright.ts` that:
  - Launches Playwright manually.
  - Uses the connector to wrap the page.
  - Runs a simple `page.aiAction`.
- Similar script for Puppeteer (if puppeteer dependency installed).

### T3. Documentation Examples
- Provide code snippets in `docs/connectors.md` showing both Hyperbrowser session + connector and local Chromium + connector.

---

## 11. Rollout Plan
1. **Phase 4 initial**: keep managed mode default, but internal code uses adapters.
2. **Beta connectors**: expose `connectPlaywrightSession` / `connectPuppeteerSession` behind feature flag or alpha docs.
3. **Provider deprecation**: once connectors are battle-tested, mark `browserProvider` as legacy (Phase 5).
4. **Connector-only future**: allow new users to skip providers entirely; managed mode becomes optional add-on.

---

## 12. Deliverables Checklist
- [ ] Generic browser/page interfaces (`generic-types.ts`).
- [ ] Playwright & Puppeteer adapters.
- [ ] Shared CDP client helper for adapters.
- [ ] Connector helpers for Playwright & Puppeteer.
- [ ] Generic context manager (multi-target support, auto-attach, diagnostics).
- [ ] HyperAgent refactor to consume `GenericPage`.
- [ ] Updated provider bridge.
- [ ] Unit + integration tests for adapters/connectors.
- [ ] Documentation for connector usage & migration guidance.

With Phase 4 complete, HyperAgent can run on either Playwright or Puppeteer with minimal friction, and users gain the flexibility to bring their own browser sessions via connectors, moving us toward a fully decoupled architecture.
